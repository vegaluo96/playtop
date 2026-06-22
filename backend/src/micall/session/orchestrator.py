"""会话编排（docs/02 §1.3 / §1.5）—— 一通电话 = 一个常驻协程，持有打断事件与发声队列。

忠实再现状态机 / 句子级首句抢跑 / 情绪 piggyback / 打断熔断 / 服务端权威计费，用
stub providers 驱动，可单测。实时链路：
  • task A 感知：传入 realtime_asr 时，_listen_loop 把上行麦克风帧（push_audio）喂流式 ASR，
    partial 回显、sentence_end 即 end-of-turn 触发一轮、用户开口即打断（barge-in §1.4-1.5）；
    无 realtime_asr 则纯文字模式，由 on_user_text 触发（ASR final 文本 / 文字输入）。
  • task C 发声：传入 audio_emit 时，_speak 把 TTS 音频块二进制下行给前端播放；否则只计时长。
  • prefix caching / 分层注入（§1.7 降 TTFT）在 ContextAssembler 留接口。
音频走二进制帧（骨架/简化路径），控制走 ServerEvent；后续可平滑换 WebRTC 媒体通道。
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator, Awaitable, Callable

from ..config import Config
from ..protocol import ServerEvent
from ..providers import ASRProvider, LLMProvider, TTSProvider
from ..context.assembler import ContextAssembler
from .billing import BillingMeter
from .emotion import EmotionStripper
from .state import CallStateMachine, Phase

log = logging.getLogger("micall.session")

Emit = Callable[[dict], Awaitable[None]]
AudioEmit = Callable[[bytes], Awaitable[None]]

_SENTENCE_END = set("。！？!?\n")


def _first_sentence_end(s: str) -> int:
    for i, ch in enumerate(s):
        if ch in _SENTENCE_END:
            return i
    return -1


class CallSession:
    def __init__(
        self,
        *,
        config: Config,
        emit: Emit,
        llm: LLMProvider,
        tts: TTSProvider,
        assembler: ContextAssembler,
        character_id: str,
        scenario: str,
        remaining_seconds: int,
        voice_id: str,
        audio_emit: AudioEmit | None = None,
        realtime_asr: ASRProvider | None = None,
    ) -> None:
        self.config = config
        self._emit_raw = emit
        self._audio_emit = audio_emit      # 下行音频（TTS 二进制帧）；None=纯控制（骨架/测试）
        self.llm = llm
        self.tts = tts
        self._asr_rt = realtime_asr        # 实时流式 ASR（task A 感知）；None=文字模式
        self.assembler = assembler
        self.character_id = character_id
        self.scenario = scenario
        self.voice_id = voice_id

        self.sm = CallStateMachine()
        self.billing = BillingMeter(
            remaining_seconds,
            int(config.billing.get("low_minutes_threshold_seconds", 60)),
        )
        self._interrupt = asyncio.Event()
        self._billing_task: asyncio.Task | None = None
        self._listen_task: asyncio.Task | None = None    # task A：ASR 感知常驻协程
        self._current_turn: asyncio.Task | None = None   # 语音模式下当前一轮（可被打断）
        self._mic_q: asyncio.Queue[bytes | None] = asyncio.Queue()  # 上行麦克风帧
        self._turn_lock = asyncio.Lock()  # 串行化一轮生成，防并发触发
        self.history: list[dict] = []      # 对话滑窗（assistant 只记实际播出，§1.5）
        self.emotion_tag = "neutral"
        self._muted = False
        self._reply_max_tokens = int(config.global_defaults.get("reply_max_tokens", 256))

    # ── 下行封装：状态未结束才发（结束后丢弃迟到事件）──
    async def _emit(self, ev: dict) -> None:
        await self._emit_raw(ev)

    # ── 接通 ──
    async def start(self) -> None:
        if self.sm.phase != Phase.IDLE:
            return
        self.sm.to(Phase.CALLING)
        # 真实：建 WebRTC + ASR/LLM/TTS 就绪后接通；骨架立即接通。失败走 call_failed。
        await self._emit(ServerEvent.connected())
        self.sm.to(Phase.LISTENING)
        await self._emit(ServerEvent.state(Phase.LISTENING.value))
        self._billing_task = asyncio.create_task(self._billing_loop())
        # task A 感知：有实时 ASR 才起（语音模式）；否则纯文字模式由 on_user_text 驱动。
        if self._asr_rt is not None:
            self._listen_task = asyncio.create_task(self._listen_loop())

    # ── 上行音频：server 收到二进制帧 → 入队，喂给 task A 的 ASR 流 ──
    def push_audio(self, frame: bytes) -> None:
        if frame and self.sm.active and not self._muted:
            self._mic_q.put_nowait(frame)

    async def _mic_frames(self) -> AsyncIterator[bytes]:
        """把上行队列包成异步帧流喂 ASR；收到哨兵 None（挂断）即收尾。"""
        while True:
            frame = await self._mic_q.get()
            if frame is None:
                return
            yield frame

    # ── task A：实时 ASR 感知（partial 回显 / final 触发一轮 / 开口即打断 §1.4-1.5）──
    async def _listen_loop(self) -> None:
        last_final = ""
        flushed = False  # 本次用户开口是否已让前端停播（每句一次，防刷）
        try:
            async for text, is_final in self._asr_rt.stream(self._mic_frames()):
                t = (text or "").strip()
                if not t or self.sm.phase in (Phase.IDLE, Phase.ENDED):
                    continue
                if not is_final:
                    # 用户开口（首个实质中间结果）→ 立刻打断：停后端生成 + 让前端停播。
                    # 关键：后端可能已把整句音频发完、状态回 listening，但前端还在播缓冲，
                    # 所以即便不在 speaking 也要发 interrupted 去 flush，否则"打断无效"。
                    if len(t) >= 2 and not flushed:
                        flushed = True
                        if self.sm.phase in (Phase.THINKING, Phase.SPEAKING):
                            await self.interrupt()
                        else:
                            await self._emit(ServerEvent.interrupted())
                    await self._emit(ServerEvent.subtitle("user", t, partial=True))
                    continue
                flushed = False  # 这句说完，下一句重新允许打断
                # 最终结果门控：太短（多半是噪声/静音误识别）或与上一句重复 → 丢弃，
                # 否则会"自说自话"刷屏（§1.4 end-of-turn 需要的是真说完，不是任何声响）。
                if len(t) < 2 or t == last_final:
                    continue
                last_final = t
                log.info("⟵ 用户说完：%r", t)
                if self.sm.phase in (Phase.THINKING, Phase.SPEAKING):
                    await self.interrupt()
                await self._begin_turn(t)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # ASR 断流/协议异常：不拖垮整通电话，退回可由文字驱动
            log.warning("实时 ASR(task A) 退出：%r", e)

    async def _begin_turn(self, text: str) -> None:
        """语音模式起一轮：先打断上一轮（task A 不被生成阻塞，才能继续听打断），再起新任务。"""
        prev = self._current_turn
        if prev is not None and not prev.done():
            self._interrupt.set()
            try:
                await prev
            except asyncio.CancelledError:
                pass
        self._current_turn = asyncio.create_task(self._guarded_turn(text))

    async def _guarded_turn(self, text: str) -> None:
        try:
            async with self._turn_lock:
                await self._generate_turn(text)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.warning("生成一轮失败：%r", e)

    # ── task B + C（骨架内联；真实拆成常驻协程经 tts_queue 解耦）──
    async def on_user_text(self, text: str) -> None:
        """文字模式输入 / ASR final 文本 → 触发一轮思考生成+发声。"""
        text = (text or "").strip()
        if not text or self.sm.phase in (Phase.IDLE, Phase.ENDED):
            return
        async with self._turn_lock:
            await self._generate_turn(text)

    async def _generate_turn(self, user_text: str) -> None:
        self._interrupt.clear()
        await self._emit(ServerEvent.subtitle("user", user_text))
        self.history.append({"role": "user", "content": user_text})

        self.sm.to(Phase.THINKING)
        await self._emit(ServerEvent.state(Phase.THINKING.value))

        messages = self.assembler.build(
            character_id=self.character_id, scenario=self.scenario, history=self.history
        )
        stripper = EmotionStripper()
        spoke: list[str] = []   # 实际播出的句子（ack 边界 → 进上下文，§1.5）
        buf = ""
        speaking = False
        emotion_sent = False

        async def open_speak() -> None:
            nonlocal speaking, emotion_sent
            if not speaking:
                self.sm.to(Phase.SPEAKING)
                await self._emit(ServerEvent.state(Phase.SPEAKING.value))
                speaking = True
            if not emotion_sent:
                self.emotion_tag = stripper.tag
                await self._emit(ServerEvent.emotion(stripper.tag))  # 一处产生，多处消费
                emotion_sent = True

        async for token in self.llm.stream(messages, max_tokens=self._reply_max_tokens):
            if self._interrupt.is_set():
                break
            buf += stripper.feed(token)
            while not self._interrupt.is_set():
                idx = _first_sentence_end(buf)
                if idx < 0:
                    break
                sentence, buf = buf[: idx + 1], buf[idx + 1:]
                if sentence.strip():
                    await open_speak()                       # 首句一出即抢跑（§1.7）
                    await self._speak(sentence, spoke)

        tail = (buf + stripper.flush()).strip()
        if tail and not self._interrupt.is_set():
            await open_speak()
            await self._speak(tail, spoke)

        # 实际播出的话进上下文；被打断则标注，让下轮能自然接住（§1.5 难点4）。
        if spoke:
            said = "".join(spoke)
            if self._interrupt.is_set():
                said += "……（被打断）"
            self.history.append({"role": "assistant", "content": said})
        self._trim_history()

        # 回 listening（打断路径已由 interrupt() 切 listening + emit interrupted）。
        if not self._interrupt.is_set() and self.sm.phase == Phase.SPEAKING:
            self.sm.to(Phase.LISTENING)
            await self._emit(ServerEvent.state(Phase.LISTENING.value))

    async def _speak(self, sentence: str, spoke: list[str]) -> None:
        """task C：一句的流式发声。有 audio_emit 则把音频块二进制下行；骨架仅计时长。"""
        await self._emit(ServerEvent.subtitle("ai", sentence))
        audio_bytes = 0
        async for chunk in self.tts.synthesize(
            sentence, voice_id=self.voice_id, emotion=self.emotion_tag
        ):
            if self._interrupt.is_set():
                return  # 熔断：停下行 + 丢弃后续（清 tts_queue 的等价）
            if self._audio_emit is not None and chunk:
                await self._audio_emit(chunk)  # 真实下行：TTS 音频帧 → 前端播放
                audio_bytes += len(chunk)
        if self._audio_emit is not None:
            log.info("⟶ 句音频 %d bytes（voice=%s）", audio_bytes, self.voice_id)
        spoke.append(sentence)  # 整句播完 → ack 边界

    # ── 打断（§1.5：停下行 → 清队列 → cancel → 半截话进上下文 → 回 listening）──
    async def interrupt(self) -> None:
        if self.sm.phase not in (Phase.THINKING, Phase.SPEAKING):
            return
        self._interrupt.set()                 # task B/C 在 token/句边界退出
        await self._emit(ServerEvent.interrupted())
        if self.sm.can(Phase.LISTENING):
            self.sm.to(Phase.LISTENING)

    # ── 计费循环（服务端权威，§5）──
    async def _billing_loop(self) -> None:
        try:
            while self.sm.active:
                await asyncio.sleep(1)
                for ev in self.billing.tick(1):
                    await self._emit(ev)
                if self.billing.exhausted:
                    await self.end(emit_ended=False)  # out_of_minutes 已发，前端走耗尽 UI
                    return
        except asyncio.CancelledError:
            pass

    def set_muted(self, on: bool) -> None:
        self._muted = on  # 前端本地也停麦；服务端记录（真实路径据此忽略上行帧）

    def set_scene(self, scene: str) -> None:
        self.scenario = scene  # 作为情境注入（assembler 下轮读取）；画面不变（固定背景）

    async def end(self, emit_ended: bool = True) -> None:
        self._interrupt.set()
        self._mic_q.put_nowait(None)        # 哨兵：让 _mic_frames 收尾 → ASR 流自然结束
        # 收掉计费 / task A / 当前一轮（避免它们在挂断后还往已关连接下行）。
        tasks = [self._billing_task, self._listen_task, self._current_turn]
        self._billing_task = self._listen_task = self._current_turn = None
        for task in tasks:
            if task is None:
                continue
            task.cancel()
            # 若 end 由该任务自身（如计费 exhausted）触发，不能 await 自己 → 只标记取消。
            if task is not asyncio.current_task():
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        if self.sm.phase != Phase.ENDED and self.sm.can(Phase.ENDED):
            self.sm.to(Phase.ENDED)
        if emit_ended:
            await self._emit(ServerEvent.ended())
        # 真实：触发离线理解引擎 worker（§3.3）回写事实层 + 更新画像。接入点：
        #   schedule_offline_understanding(self.character_id, user_id, self.history)

    def _trim_history(self, max_turns: int = 12) -> None:
        if len(self.history) > max_turns:
            self.history = self.history[-max_turns:]
