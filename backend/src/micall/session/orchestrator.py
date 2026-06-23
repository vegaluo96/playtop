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
import re
import time
from typing import AsyncIterator, Awaitable, Callable

_NON_WORD = re.compile(r"\W+", re.UNICODE)

# 语气词/backchannel 单字集：回声、呼吸、口水音常被 ASR 识成「嗯」这类，老误打断 AI
# （用户实测：asr 老觉得我在嗯）。纯由这些字（含重复/带标点）组成的识别结果视为非实质，
# 不打断、不触发轮次、不上字幕。真说话（哪怕「嗯…我觉得」）一旦带实义词照常处理。
_FILLER_CHARS = set("嗯唔呃啊哦噢喔哼唉诶欸呢吧嘛啦呀哟嗷呣姆")


def _norm(s: str) -> str:
    """去标点/空白，保留中英文字符，用于回声重叠判定。"""
    return _NON_WORD.sub("", s or "")


def _is_filler(s: str) -> bool:
    """纯语气词/backchannel（嗯/啊/哦…，含重复与标点）→ True（非实质语音）。"""
    nt = _norm(s)
    return not nt or all(ch in _FILLER_CHARS for ch in nt)


_ACTIONS = re.compile(r"（[^）]*）|\([^)]*\)|【[^】]*】|\*[^*]*\*")


def _strip_actions(s: str) -> str:
    """去掉括号里的动作/神态/旁白（（轻声笑）/(smiles)/【…】/*…*）：这些是表演提示，不该被 TTS 念出来。"""
    return _ACTIONS.sub("", s or "").strip()

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


def _split_sentences(s: str) -> list[str]:
    """按句末标点切成短句（保留标点）。用于字幕逐句下发，避免一长段撑开屏幕。"""
    out: list[str] = []
    cur = ""
    for ch in s:
        cur += ch
        if ch in _SENTENCE_END:
            if cur.strip():
                out.append(cur.strip())
            cur = ""
    if cur.strip():
        out.append(cur.strip())
    return out


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
        embedder=None,
    ) -> None:
        self.config = config
        self._emit_raw = emit
        self._audio_emit = audio_emit      # 下行音频（TTS 二进制帧）；None=纯控制（骨架/测试）
        self.llm = llm
        self.tts = tts
        self._asr_rt = realtime_asr        # 实时流式 ASR（task A 感知）；None=文字模式
        self._embedder = embedder          # 记忆检索向量化（Embedding 节点）；None=关键词召回
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
        self._usage = {"llm_in_chars": 0, "llm_out_chars": 0, "tts_chars": 0}  # 成本埋点累计（整通）
        self._ai_said = ""                  # 本轮 AI 已说出的文本（用于回声判定）
        self._audio_until = 0.0             # AI 下行音频估计播放到的时刻（monotonic 秒）
        self._muted = False
        # 回声防护是个分层方案：**前端半双工**才是主力——AI 音频外放时前端根本不上行麦克风，
        # 公放回声从源头进不来（Web 端无 WebRTC AEC 时的成熟做法，见 frontend/logic/audio.ts）。
        # 这里只留一层轻量服务端兜底（config.turn，每通重载即生效）：
        #   echo_tail_ms  —— AI 音频播完后仍按「可能回声」对待的拖尾窗（盖住前端半双工放开的瞬间 + ASR 延迟）。
        #   echo_overlap  —— 音频播放中，识别文本与 AI 已说内容的字符重叠达此比例即判回声。
        turn = config.turn or {}
        self._echo_tail = float(turn.get("echo_tail_ms", 1200)) / 1000.0
        self._echo_overlap = float(turn.get("echo_overlap", 0.7))
        # 安全上限（防跑飞）而非长短控制——长短交给提示里的「一两句」。设得足够高，正常回复绝不触顶被截断。
        self._reply_max_tokens = int(config.global_defaults.get("reply_max_tokens", 2048))

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

    def _looks_like_echo(self, text: str) -> bool:
        """识别到的"用户"文本是不是 AI 自己声音的回灌。两段窗口、两种力度：
          • 子串命中（AI 说过的原话被原样转写回来）→ 任何回声窗内都判回声（高置信）。
          • 模糊重叠（ASR 把回声转写得不全字对字）→ 仅在音频「仍在播放」时启用；此刻真实用户多在打断、
            会另走门槛逻辑，宁可严一点。播放结束后的拖尾窗只认子串，避免把「附和式真回复」误判成回声。
        回声窗 = 直到 _audio_until + echo_tail：echo_tail 要盖住 ASR 自身识别延迟（VAD 判句+网络），
        否则 AI 自己的话拖几秒后被识别出来，会被当成用户「凭空说的一轮」（用户实测：重复冒出「你好」）。"""
        if not self._ai_said:
            return False
        now = time.monotonic()
        if now > self._audio_until + self._echo_tail:
            return False
        nt = _norm(text)
        if len(nt) < 2:
            return False
        said = _norm(self._ai_said)
        if nt in said:
            return True
        if now <= self._audio_until:        # 音频还在播：模糊重叠也判回声
            chars = set(nt)
            overlap = sum(1 for ch in chars if ch in said) / len(chars)
            return overlap >= self._echo_overlap
        return False

    # ── task A：实时 ASR 感知（partial 回显 / final 触发一轮 / 开口即打断 §1.4-1.5）──
    async def _listen_loop(self) -> None:
        recent: dict[str, float] = {}  # 最近 final → 时刻：同句短时间内重复出现（回声/幻听）去重
        flushed = False  # 本次用户开口是否已让前端停播（每句一次，防刷）
        try:
            async for text, is_final in self._asr_rt.stream(self._mic_frames()):
                t = (text or "").strip()
                if not t or self.sm.phase in (Phase.IDLE, Phase.ENDED):
                    continue
                if self._looks_like_echo(t):
                    continue  # AI 自己的声音回灌麦克风（前端半双工漏掉的残余），忽略：不打断、不触发新一轮
                if _is_filler(t):
                    continue  # 纯语气词「嗯/啊/哦…」（多为回声/呼吸误识）：不打断、不触发轮次、不上字幕
                if not is_final:
                    # 用户开口（实质中间结果）→ 打断：停后端生成 + 让前端停播。
                    # 后端可能已把整句音频发完、状态回 listening 但前端还在播缓冲，故即便不在 speaking
                    # 也发 interrupted 去 flush，否则"打断无效"。
                    if len(_norm(t)) >= 2:
                        if not flushed:
                            flushed = True
                            if self.sm.phase in (Phase.THINKING, Phase.SPEAKING):
                                await self.interrupt()
                            else:
                                await self._emit(ServerEvent.interrupted())
                        await self._emit(ServerEvent.subtitle("user", t, partial=True))
                    continue
                flushed = False  # 这句说完，下一句重新允许打断
                now = time.monotonic()
                recent = {k: ts for k, ts in recent.items() if now - ts < 10.0}  # 只看近 10 秒
                # 最终结果门控：太短（噪声/静音误识别）或 10 秒内重复出现的同句（回声/幻听）→ 丢弃，
                # 否则会"自说自话刷屏 / 凭空冒出重复的一句"（§1.4：end-of-turn 要的是真说完）。
                if len(_norm(t)) < 2 or t in recent:
                    continue
                recent[t] = now
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

    async def _embed_query(self, text: str) -> list[float] | None:
        """把本轮用户话向量化用于情节记忆余弦召回。仅配了 Embedding 且库里有可检索记忆时才嵌入，
        否则纯属给实时路径白加一次网络往返（开场/新会话尤其明显，对话发钝）。带紧超时兜底。"""
        if self._embedder is None or not (text or "").strip():
            return None
        mem, prof = self.assembler.memory, self.assembler.profile
        if mem is None or prof is None or not mem.has_facts(prof.user_id, self.character_id):
            return None  # 没有可召回的记忆 → 不嵌入，省一次往返（recall 也只会返回空）
        try:
            # 实时路径硬上限：嵌入慢/卡也不拖累对话，超时即退关键词召回。
            return await asyncio.wait_for(self._embedder.embed_one(text), timeout=1.0)
        except Exception as e:  # 超时/网络/鉴权：静默退关键词召回（asyncio.TimeoutError 也是 Exception）。
            log.warning("query 向量化跳过（超时/失败），退关键词召回：%r", e)
            return None

    async def _generate_turn(self, user_text: str) -> None:
        self._interrupt.clear()
        # 注意：回声基准 _ai_said 不在此清空——上一轮 AI 的音频可能还在前端缓冲播放，
        # 思考阶段(THINKING)仍要靠它拦住拖尾回声；等真正开口(open_speak)再以本轮文本重置。
        await self._emit(ServerEvent.subtitle("user", user_text))
        self.history.append({"role": "user", "content": user_text})

        self.sm.to(Phase.THINKING)
        await self._emit(ServerEvent.state(Phase.THINKING.value))

        qvec = await self._embed_query(user_text)  # 配了 Embedding 节点才算；失败/未配 → None（退关键词）
        messages = self.assembler.build(
            character_id=self.character_id, scenario=self.scenario, history=self.history,
            query_vector=qvec,
        )
        self._usage["llm_in_chars"] += sum(len(str(m.get("content", ""))) for m in messages)  # 成本：LLM 输入
        stripper = EmotionStripper()
        spoke: list[str] = []   # 实际播出的句子（ack 边界 → 进上下文，§1.5）
        buf = ""

        # 整段回复先流式生成完，再「一次」合成下发 —— 修复用户实测「说话时音色像换了个人」：
        #   ① 旧版「首句抢跑 + 尾段」是两次独立 TTS 生成，同一 voice_id 在句界仍会渲染出差异 →
        #      像换了个人。改成整段一次生成，全程同一次渲染、同一个人。
        #   ② 不再把每轮跳变的情绪标签喂给 TTS（见 _speak）——情绪在 happy/中性/sad 间跳，MiniMax 会把
        #      同一音色渲染成不同的人。情绪只发前端/编排（UI 线索），绝不动音色。
        # DeepSeek-flash 很快，一两句的整段生成只比首句抢跑多约 0.3s，换来全程同一个人，值。
        async for token in self.llm.stream(messages, max_tokens=self._reply_max_tokens):
            if self._interrupt.is_set():
                break
            buf += stripper.feed(token)

        reply = (buf + stripper.flush()).strip()
        if reply and not self._interrupt.is_set():
            self._ai_said = ""  # 进入发声：以本轮 AI 文本作为新的回声基准（此前保留上一轮防拖尾回声）
            self.emotion_tag = stripper.tag
            self.sm.to(Phase.SPEAKING)
            await self._emit(ServerEvent.state(Phase.SPEAKING.value))
            await self._emit(ServerEvent.emotion(stripper.tag))  # 仅供前端/编排（不喂 TTS，见 _speak）
            await self._speak(reply, spoke)

        # 实际播出的话进上下文；被打断则标注，让下轮能自然接住（§1.5 难点4）。
        if spoke:
            said = "".join(spoke)
            self._usage["llm_out_chars"] += len(said)   # 成本：LLM 输出
            if self._interrupt.is_set():
                said += "……（被打断）"
            self.history.append({"role": "assistant", "content": said})
        self._trim_history()

        # 回 listening（打断路径已由 interrupt() 切 listening + emit interrupted）。
        # 含空回复兜底：没说出话也从 THINKING 回到 LISTENING，避免卡在思考态。
        if not self._interrupt.is_set() and self.sm.phase in (Phase.SPEAKING, Phase.THINKING):
            self.sm.to(Phase.LISTENING)
            await self._emit(ServerEvent.state(Phase.LISTENING.value))

    async def _speak(self, sentence: str, spoke: list[str]) -> None:
        """task C：一句的流式发声。有 audio_emit 则把音频块二进制下行；骨架仅计时长。"""
        spoken = _strip_actions(sentence)   # 去掉（轻声笑）这类舞台提示，别让 TTS 念出来
        if not spoken:
            return  # 整句都是括号动作/旁白：不发音、不进上下文
        self._usage["tts_chars"] += len(spoken)   # 成本：TTS 合成字符
        # 字幕逐句下发（短行，不撑屏）；音频整段一次合成（句间不断气）。
        for seg in _split_sentences(spoken):
            await self._emit(ServerEvent.subtitle("ai", seg))
        self._ai_said += spoken  # 记入回声基准（这句即将在前端播放，可能回灌麦克风）
        audio_bytes = 0
        async for chunk in self.tts.synthesize(
            spoken, voice_id=self.voice_id, emotion=""   # 不喂动态情绪：保证整通同一个人（情绪跳变会"像换了个人"）
        ):
            if self._interrupt.is_set():
                return  # 熔断：停下行 + 丢弃后续（清 tts_queue 的等价）
            if self._audio_emit is not None and chunk:
                await self._audio_emit(chunk)  # 真实下行：TTS 音频帧 → 前端播放
                audio_bytes += len(chunk)
        if self._audio_emit is not None:
            # 估计这句在前端播放到的时刻（24kHz 16bit 单声道）→ 用于回声判定的时间窗。
            dur = audio_bytes / (24000 * 2)
            self._audio_until = max(time.monotonic(), self._audio_until) + dur
            log.info("⟶ 句音频 %d bytes（voice=%s）", audio_bytes, self.voice_id)
        spoke.append(spoken)  # 整句播完 → ack 边界（进上下文用清洗后的口语文本）

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

    def cost_breakdown(self) -> list[tuple[str, int, int]]:
        """按整通实际用量×config.cost 估算成本，返回 [(node, units, cost_micros)]（micros=微美元）。
        实时路径三节点：llm_fast（输入+输出 token）、tts（合成字符）、asr（整通秒）。挂断时写 usage_log。"""
        c = self.config.cost or {}
        cpt = float(c.get("chars_per_token", 2)) or 2.0
        tok_rate = (c.get("usd_per_1k_tokens") or {})
        out: list[tuple[str, int, int]] = []
        llm_tokens = (self._usage["llm_in_chars"] + self._usage["llm_out_chars"]) / cpt
        if llm_tokens >= 1:
            micros = round(llm_tokens / 1000 * float(tok_rate.get("llm_fast", 0)) * 1_000_000)
            out.append(("llm_fast", round(llm_tokens), micros))
        if self._usage["tts_chars"] >= 1:
            micros = round(self._usage["tts_chars"] / 1000 * float(c.get("usd_per_1k_chars_tts", 0)) * 1_000_000)
            out.append(("tts", self._usage["tts_chars"], micros))
        asr_sec = int(getattr(self.billing, "elapsed", 0) or 0)
        if asr_sec >= 1:
            micros = round(asr_sec / 60 * float(c.get("usd_per_minute_asr", 0)) * 1_000_000)
            out.append(("asr", asr_sec, micros))
        return out

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

    def _trim_history(self, max_turns: int = 30) -> None:
        # 通话内滑窗。12 条（6 轮）太短，长通话里会忘掉前面聊的 → 越聊越没头绪；放到 30 条（约 15 轮），
        # 配合 system 前缀缓存，多出的历史多走缓存价，连贯性明显好。assembler 还会按 budget_chars 再裁。
        if len(self.history) > max_turns:
            self.history = self.history[-max_turns:]
