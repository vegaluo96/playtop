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
import random
import re
import time
from contextlib import aclosing
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


_LAUGH_CHARS = set("哈嘻嘿呵")


def _is_laughter(s: str) -> bool:
    """纯笑声（哈哈/嘻嘻/嘿嘿…）→ True。AI 说话时用户笑一声是附和、不是插话，不该打断她（让她说完）。"""
    nt = _norm(s)
    return len(nt) >= 2 and all(ch in _LAUGH_CHARS for ch in nt)


# ASR 在静音/噪声/回声上会「幻听」出训练语料里的高频套话（尤其英文字幕水印："Thank you." "Yes."
# "Thank you for watching." "Please subscribe."；中文则常见点赞订阅类水印），用户根本没说。
# 这些纯属噪声，绝不能触发一轮（实测：凭空冒出「Thank you.YesYes.」，用户没开口）。
_HALLUCINATION_WORDS = {
    "thank", "thanks", "thankyou", "you", "your", "yes", "yeah", "yep", "ya", "bye", "goodbye",
    "please", "subscribe", "subscribing", "subscription", "watching", "watch", "video", "channel",
    "like", "comment", "share", "hmm", "mm", "mhm", "uh", "um", "oh", "okay", "ok",
    "amara", "org", "www", "com", "music", "applause", "foryou", "for", "next", "time", "see",
}
_HALLUCINATION_PHRASES = {  # 整句套话（去标点空白后比对，覆盖中英水印）
    "请不吝点赞订阅转发打赏支持明镜与点点栏目", "请不吝点赞订阅转发打赏",
    "谢谢观看", "谢谢大家观看", "谢谢大家", "下期再见", "感谢观看", "明镜需要您的支持",
    "字幕志愿者", "字幕由amaraorg社区提供", "字幕由社区提供",
}


def _is_asr_hallucination(s: str) -> bool:
    """ASR 静音/噪声幻听（英文字幕水印 / 点赞订阅类）→ True，整条丢弃。
    含中文则交给常规过滤（中文水印已在 phrases 里挡），不按英文词表误伤真中文。"""
    raw = (s or "").strip()
    if not raw:
        return True
    norm = re.sub(r"[\W_]+", "", raw).lower()
    if norm in _HALLUCINATION_PHRASES:
        return True
    if re.search(r"[一-鿿]", raw):
        return False  # 有中文：不按英文幻听词表判（避免误伤），由 _is_filler / 门槛等处理
    words = re.findall(r"[a-z]+", raw.lower())
    if not words:
        return False
    # 每个词都是已知幻听填充词（含重复拼接，如 yesyes=yes×2、thankyou）才判幻听；只要有一个实词就放行。
    def _junk(w: str) -> bool:
        if w in _HALLUCINATION_WORDS:
            return True
        for base in ("thankyou", "thank", "yes", "bye", "you", "haha"):
            if len(w) >= 2 * len(base) and len(w) % len(base) == 0 and w == base * (len(w) // len(base)):
                return True
        return False
    return all(_junk(w) for w in words)


from ..config import Config
from ..protocol import ServerEvent
from ..providers import ASRProvider, LLMProvider, TTSProvider
from ..context.assembler import ContextAssembler
from .billing import BillingMeter
from .emotion import (
    clean_for_subtitle, clean_for_tts, humanize_for_tts, prosody_for, take_sentence_emotion,
)
from .state import CallStateMachine, Phase

log = logging.getLogger("micall.session")

Emit = Callable[[dict], Awaitable[None]]
AudioEmit = Callable[[bytes], Awaitable[None]]

_AUDIO_CHUNK = 4096   # 预合成缓冲回放时的分块大小（别一次性灌一大块给前端）

# 开场多样化（修「每次开头都重复一样的话」）：开场默认靠静态指令 + 静态自主状态（如「刚调好花椒鸡尾酒」），
# 模式太强 → 每通都同一句。每通随机选一个【开场角度】注入，把模型从同一个 mode 上推开。
_OPENING_ANGLES = [
    "这次就着【此刻的时间/场景】随口起头（这个点怎么还醒着 / 这天气…），别提你正忙的事。",
    "这次直接【好奇地问 TA 一件】你想知道的小事起头，别先说自己。",
    "这次说一件【你自己此刻的心情或念头】起头（但别又是你正做的那件老事，换件别的）。",
    "这次就一句【简单温暖的招呼】，干净利落不铺垫。",
    "这次顺着【你对 TA 的感觉/惦记】起头，像惦记一个人那样自然带出来。",
    "这次用你性子里最自然的方式起头，但【换个和以往不同的开法】。",
]


def _varied_opening(base: str) -> str:
    """给开场指令随机叠一个角度 + 反重复要求，治「每次开头都同一句」。纯函数，便于测试。"""
    return (base + random.choice(_OPENING_ANGLES)
            + "（务必和你以往的开场【不一样】：别每次都同一句、同一件事、同一个场景起头。）")

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


_ACTION_OPEN = "（【"      # 中文舞台说明/旁白的开符（全角）：其内部的句末标点不该切句
_ACTION_CLOSE = "）】"


def _take_first_sentence(buf: str, minlen: int = 6) -> tuple[str, str]:
    """从已生成文本切出第一个完整句子（到句末标点，含连续标点），返回 (句子, 剩余)；无完整句 → ("", buf)。
    用于「首句抢跑」：第一句一成形就立刻合成发声，把首字延迟从「整段 LLM 生成」降到「首句 LLM 生成」。
    minlen：太短的首句（如「嗯。」「好的。」）并入下一句再抢跑，少一个 TTS 接缝、更丝滑。
    括号感知：在未闭合的中文旁白/动作（（…）/【…】/*…*）里遇到句末标点不切——否则像
    「（轻笑了声，…敲了两下。）正经话」会被 。 拦腰切成两句，各自括号不配对、清洗漏掉 → 旁白漏进字幕/被念。"""
    depth = 0
    star = False
    for i, ch in enumerate(buf):
        if ch in _ACTION_OPEN:
            depth += 1
            continue
        if ch in _ACTION_CLOSE:
            if depth > 0:
                depth -= 1
            continue
        if ch == "*":
            star = not star
            continue
        if ch in _SENTENCE_END and depth == 0 and not star:
            j = i + 1
            while j < len(buf) and buf[j] in _SENTENCE_END:
                j += 1
            head = buf[:j].strip()
            if len(head) >= minlen:
                return head, buf[j:]
            # 首句太短 → 不在此处切，继续找下一个句末（让它和后面合并，累计够长再抢跑）
    return "", buf


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
        scenario_prompt: str = "",
        audio_emit: AudioEmit | None = None,
        realtime_asr: ASRProvider | None = None,
        embedder=None,
        seed_history: list[dict] | None = None,
        continuation: bool = False,
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
        self.scenario = scenario                              # 短标签：通话记录/统计用（前端传 key，如 heart/sc0）
        self.scenario_prompt = scenario_prompt or scenario    # 完整情境指令：喂 LLM（缺省回退标签，向后兼容）
        self.voice_id = voice_id
        # 角色卡 voice.emotion_map：把逐句情绪标签按本角色重路由到不同韵律档（见 prosody_for）。
        self.emotion_map = (getattr(assembler.character, "emotion_map", None) or {})
        # has_facts 一通电话内不变（事实由离线引擎在挂断后才写）→ 开场算一次缓存，
        # 省掉每轮思考前那次查库往返。查库失败按「无记忆」处理（仅退关键词召回，安全）。
        self._mem_has_facts = False
        try:
            mem, prof = assembler.memory, assembler.profile
            self._mem_has_facts = bool(
                mem is not None and prof is not None and mem.has_facts(prof.user_id, character_id)
            )
        except Exception as e:
            log.warning("has_facts 预查失败，按无记忆处理：%r", e)

        self.sm = CallStateMachine()
        self.billing = BillingMeter(
            remaining_seconds,
            int(config.billing.get("low_minutes_threshold_seconds", 60)),
        )
        self._interrupt = asyncio.Event()
        self._billing_task: asyncio.Task | None = None
        self._listen_task: asyncio.Task | None = None    # task A：ASR 感知常驻协程
        self._current_turn: asyncio.Task | None = None   # 语音模式下当前一轮（可被打断）
        self._greet_task: asyncio.Task | None = None     # 主动开场白任务（由前端 ready 触发；挂断时取消）
        self._greeted = False                            # 开场一次性守卫（begin_conversation 幂等）
        self._opening_active = False                     # 开场白播放期：_listen_loop 整段丢 ASR（防自我打断）
        # 上行麦克风帧：有界（≈1–1.5s）。无界时 ASR/网络一慢，帧就积压，ASR 永远在嚼过期音频
        # → 越聊越延迟、还容易把旧片段重判（与"一句被当五遍"同源）。满则丢最旧、永远喂最新（见 push_audio）。
        self._mic_q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)
        self._turn_lock = asyncio.Lock()  # 串行化一轮生成，防并发触发
        # 对话滑窗（assistant 只记实际播出，§1.5）。续接重拨：用上一通掉线前的尾巴播种，
        # 让 AI 接着聊而非从头自我介绍（_continuation 控制开场走「续接指令」+ 允许带 history 也开口）。
        self.history: list[dict] = list(seed_history or [])
        self._continuation = bool(continuation)
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
        # 拖尾窗放宽到 1.6s（原 1200）：全双工外放下，AI 话音回授常在播放刚结束的瞬间被 ASR 转写出来，
        # 窗太短就漏成「自言自语」。重叠门槛 0.65（原 0.7）略松，多兜住转写不全的回声；真用户附和多不与 AI 原话重叠，误伤小。
        self._echo_tail = float(turn.get("echo_tail_ms", 1600)) / 1000.0
        self._echo_overlap = float(turn.get("echo_overlap", 0.65))
        # 下行播放延迟补偿：全双工(RTC)经 coturn 中继 + jitter buffer，AI 这句实际播得比合成时刻晚。
        # 把它加进 _audio_until，让「播放中」回声窗盖住外放回授时段 → 治「听到自己 / 屏幕冒出没说的话」。
        self._play_pad = float(turn.get("echo_play_pad_ms", 500)) / 1000.0
        # 灵敏度门槛（治「一点声音就反应/打断」）。文本越长越像真说话，短碎片多是噪声/呼吸/回授。可在 turn 配置调：
        #   bargein_min_chars —— AI 外放时，partial 达到这么多字才算真打断。4 是稳值：挡掉 AI 自己声音回授的短碎片
        #     （太低会"自己打断自己"→ 听着像不说话）；戴耳机/RTC 干净环境可调到 2–3 让短插话更跟手。
        #   partial_min_chars —— AI 不在播时，partial 回显/预停播的下限（越大越不会"一点声音就在屏上冒字/抢拍"）。
        #   turn_min_chars    —— final 触发新一轮的下限（保留「好的/是啊」等真短回复，故默认 2，不宜再高）。
        self._bargein_min_chars = int(turn.get("bargein_min_chars", 4))
        self._partial_min_chars = int(turn.get("partial_min_chars", 2))
        self._turn_min_chars = int(turn.get("turn_min_chars", 2))
        # 全双工 RTC（浏览器硬件 AEC）连上后，麦克风对 AI 自己声音的回授大幅减弱，但浏览器 AEC 外放下
        # 并不完美、仍会漏一点。故只做「适度」放宽：打断门槛 4→3（短插话更跟手），但【回声判定始终保留】
        # ——不放开模糊重叠，否则漏进来的 AI 余音会被当插话「说到一半自我打断」(实测踩坑)。退回 WS 即回门槛 4。
        self._full_duplex_aec = False
        self._bargein_min_chars_aec = int(turn.get("bargein_min_chars_aec", 3))
        # AEC 热身：RTC 全双工刚连上时，浏览器回声消除的自适应滤波器要 ~1-2s 才收敛；这段里 AI 在外放时
        # 麦克风录到的多是「没消干净的余音」→ 被识别成错字（开头几句对不上）。故连上后给一个热身窗口：
        # 窗口内【AI 正在播】时一律丢弃 ASR（不触发回合、不打断、不上字幕），等收敛了再正常全双工。
        # AI 不在播时用户真说话照常处理（不丢真话）。可在 turn.aec_warmup_s 调。
        self._aec_warmup_s = float(turn.get("aec_warmup_s", 1.8))
        self._aec_warmup_until = 0.0
        # 安全上限（防跑飞）兼顾不长篇：语音单轮该短，2048 会让模型偶尔长篇大论→越聊越卡。默认 400 留足
        # 正常回复（1~3 句）余量、只砍异常长篇；想更短/更长改 global_defaults.reply_max_tokens。
        # 角色级覆盖优先（runtime_overrides.reply_max_tokens）：让话痨型角色多说几句、惜字型更短。
        _ro = (getattr(assembler.character, "runtime_overrides", None) or {})
        self._reply_max_tokens = int(_ro.get("reply_max_tokens")
                                     or config.global_defaults.get("reply_max_tokens", 400))
        # 通话内历史滑窗条数：长聊时每轮喂快脑的历史越短→首字越快、不越聊越慢。默认 20 条(10 轮)，更久远
        # 上下文交给 L3 记忆召回兜底。想更连贯调大、想更快调小（global_defaults.incall_max_turns）。
        self._incall_max_turns = max(2, int(config.global_defaults.get("incall_max_turns", 20)))
        # LLM 首 token 墙钟超时：连上后若卡住（不吐 token），不要干等 httpx 读超时(30s)才解脱 →
        # 表现为"一直在思考/突然卡死"。只卡首 token（宽松，不误杀慢而有效的长回复）。
        # 8s→6s：真·静默卡死时少 2s 死寂；瞬时报错已由 provider 层退避重试兜住（在此超时窗内完成），
        # 故收紧不误杀重试。想更稳可调回 8、想更激进可调小（turn.llm_first_token_timeout_s）。
        self._llm_first_token_timeout = float(turn.get("llm_first_token_timeout_s", 6.0))
        # 嵌入召回的接话提速旋钮（都不影响语音/VAD）：
        #   embed_min_chars —— 短话（"嗯""好的""是啊"）不嵌入：嵌一两个字本就没语义、召回多是噪声，
        #     却白加一次往返（最多 embed_timeout_s）拖慢接话。短话走关键词召回足矣。低于此长度跳过嵌入。
        #   embed_timeout_s —— 嵌入墙钟上限，超时即退关键词（不拖累实时接话）。
        self._embed_min_chars = int(turn.get("embed_min_chars", 4))
        self._embed_timeout_s = float(turn.get("embed_timeout_s", 0.6))
        # 接通后【主动开口】：不等用户先说，AI 先说一句针对 TA 的开场白——填掉「接通到用户开口」的冷场，
        # 个性化素材（关系/上次聊到什么/隔了多久/上次心情/节日）assembler 在开场轮已组装。默认开。
        self._greet_on_start = bool(turn.get("greet_on_start", True))
        self._opening_directive = str(turn.get("opening_directive",
            "（来电刚接通，请你先开口说第一句话，自然地招呼 TA。"
            "若还不大认识 TA（初识），就带一点真想认识 TA 的好奇起个头——按你的性子轻轻起个话头/问一句，"
            "别审问、别太满；若是老相识，可自然带出你记得或惦记的某件事，让 TA 觉得被记着。"
            "但绝不要编造没真实发生过的共同经历或'上次谈过的事'——拿不准就只温暖地打个招呼。"
            "别等 TA 先开口、别太长，一两句即可。）"))
        # 续接重拨开场：上一通刚因网络断了、TA 又拨回来（上面对话里就是你们刚聊的）。别重新开场。
        self._continuation_directive = str(turn.get("continuation_directive",
            "（你们这通电话刚因为网络断了、TA 又拨回来——上面就是你们断线前正聊着的话。"
            "【绝不要】重新打招呼、自我介绍、或问『你好/在吗/想聊点什么』；就当从没断过，"
            "自然接住刚才那个话茬继续说下去。最多极轻地带一句『刚信号断了下』，但别复述刚才说过的、"
            "也别问『刚说到哪了』。一两句即可。）"))

    # ── 下行封装：状态未结束才发（结束后丢弃迟到事件）──
    async def _emit(self, ev: dict) -> None:
        await self._emit_raw(ev)

    # ── 接通 ──
    async def start(self) -> None:
        if self.sm.phase != Phase.IDLE:
            return
        self.sm.to(Phase.CALLING)
        # 初始余额已耗尽（remaining<=0）：直接发 out_of_minutes 进终态，不启动麦克风/LLM/TTS。
        # 否则 _billing_loop 首个 tick 在 exhausted 时返回空、不发 out_of_minutes 就静默 end → 前端无「余额不足」提示。
        if self.billing.exhausted:
            await self._emit(ServerEvent.out_of_minutes())
            await self.end(emit_ended=False)   # 已发 out_of_minutes，前端走耗尽 UI；进 ENDED 并清理
            return
        # 真实：建 WebRTC + ASR/LLM/TTS 就绪后接通；骨架立即接通。失败走 call_failed。
        await self._emit(ServerEvent.connected())
        self.sm.to(Phase.LISTENING)
        await self._emit(ServerEvent.state(Phase.LISTENING.value))
        # 计费/计时【不在此起】：改由前端「ready(接通就绪)」触发（见 begin_conversation）——拨通 loading 期不计费、
        # 前端显示的时长（由 billing.elapsed 驱动）也从接通后才走。
        # task A 感知：有实时 ASR 才起（语音模式）；否则纯文字模式由 on_user_text 驱动。
        if self._asr_rt is not None:
            self._listen_task = asyncio.create_task(self._listen_loop())
        # 主动开场白【不在此触发】：改由前端「传输就绪(ready)」驱动（见 begin_conversation）——拨通先进
        # 「接通中」loading 把 RTC 连好、AEC 热好，AI 才接起来开口，开场白直接走在已就绪传输上（不切通道=不顿、
        # AEC 已在+开场期抑制 ASR=不自我打断、loading 盖住建连=不冷场）。

    # ── 上行音频：server 收到二进制帧 → 入队，喂给 task A 的 ASR 流 ──
    def push_audio(self, frame: bytes) -> None:
        if frame and self.sm.active and not self._muted:
            try:
                self._mic_q.put_nowait(frame)
            except asyncio.QueueFull:
                # 队列满（ASR/网络慢导致积压）：丢最旧一帧腾位，再塞最新 → 始终喂最新音频，防"越聊越延迟"。
                try:
                    self._mic_q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    self._mic_q.put_nowait(frame)
                except asyncio.QueueFull:
                    pass

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
            return True                     # AI 原话被原样转写回来：任何模式都判回声（高置信）
        # 即便全双工硬件 AEC 也【始终保留】模糊重叠判定：浏览器 AEC 外放下并不完美，会漏一点 AI 自己的
        # 声音进麦克风；若此时放开判定，漏进来的 AI 余音会被当插话 →「说到一半自我打断」(实测踩坑)。
        if now <= self._audio_until:        # 音频还在播：模糊重叠也判回声（含 AEC，防自我打断）
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
                if self._opening_active:
                    continue  # 开场白播放期：整段丢 ASR（不打断/不触发轮次/不上字幕）——防 AI 把自己的开场白当用户插话
                if self._looks_like_echo(t):
                    continue  # AI 自己的声音回灌麦克风（前端半双工漏掉的残余），忽略：不打断、不触发新一轮
                if _is_filler(t):
                    continue  # 纯语气词「嗯/啊/哦…」（多为回声/呼吸误识）：不打断、不触发轮次、不上字幕
                if _is_asr_hallucination(t):
                    log.info("丢弃 ASR 幻听：%r", t)
                    continue  # ASR 静音/噪声幻听（Thank you./Yes./点赞订阅水印）：用户没说，整条丢弃
                # 灵敏度门槛：AI 外放(扬声器全双工)时，麦克风会录回 AI 自己的声音，经 AEC/ASR 变成短碎片
                # （如「林管。」）；AI 不在播时，环境噪声/呼吸也常被误识成一两个字。短文本多是噪声，长文本才像真说话。
                # 故 partial（回显/预停播）按是否外放分别用较高门槛；final（真触发一轮）保留较低门槛以容纳「好的」等短回复。
                ai_playing = time.monotonic() <= self._audio_until
                # AEC 热身窗内 + AI 正在播：浏览器回声消除还没收敛，此刻录到的多是没消干净的 AI 余音，
                # 整条丢弃（不上字幕、不打断、不触发回合）→ 治「一上来几句识别成错字」。AI 不在播时照常处理（不丢真话）。
                if ai_playing and self._full_duplex_aec and time.monotonic() < self._aec_warmup_until:
                    continue
                if ai_playing and _is_laughter(t):
                    continue  # AI 说话时你笑一声/附和（哈哈/嘻嘻）：是捧场不是插话，不打断、不另起一轮，让她说完
                # 有硬件 AEC（全双工 RTC）时打断门槛降到 2，短插话即刻生效；无 AEC 沿用稳值（挡回授碎片）。
                bargein_min = self._bargein_min_chars_aec if self._full_duplex_aec else self._bargein_min_chars
                partial_min = bargein_min if ai_playing else self._partial_min_chars
                if not is_final:
                    # 用户开口（实质中间结果）→ 打断：停后端生成 + 让前端停播。
                    # 后端可能已把整句音频发完、状态回 listening 但前端还在播缓冲，故即便不在 speaking
                    # 也发 interrupted 去 flush，否则"打断无效"。
                    if len(_norm(t)) >= partial_min:
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
                nt = _norm(t)   # 归一化（去标点/空白）做去重键：「你好」「你好。」「你 好」视为同句，挡住变体重复
                recent = {k: ts for k, ts in recent.items() if now - ts < 10.0}  # 只看近 10 秒
                # final 门槛：外放时沿用较高的 bargein 门槛（挡回授碎片触发的假轮次）；不在播时用 turn 门槛（容纳短回复）。
                final_min = bargein_min if ai_playing else self._turn_min_chars
                # 最终结果门控：太短（噪声/静音误识别/外放回授碎片）或 10 秒内重复出现的同句（回声/幻听/重判）
                # → 丢弃，否则会"自说自话刷屏 / 凭空冒出重复的一句"（§1.4：end-of-turn 要的是真说完）。
                if len(nt) < final_min or nt in recent:
                    continue
                recent[nt] = now
                log.info("⟵ 用户说完：%r", t)
                # 「免费升级」：把这句话从声音里听出的情绪交给 assembler，折进本轮 → 角色顺着你的语气接话。
                try:
                    self.assembler.set_user_voice_emotion(getattr(self._asr_rt, "last_emotion", ""))
                except Exception:
                    pass
                if self.sm.phase in (Phase.THINKING, Phase.SPEAKING):
                    await self.interrupt()
                await self._begin_turn(t)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # ASR 断流/协议异常：不拖垮整通电话，退回可由文字驱动
            log.warning("实时 ASR(task A) 退出：%r", e)
            try:
                if self.sm.phase not in (Phase.IDLE, Phase.ENDED):
                    await self._emit(ServerEvent.asr_failed())  # 通知前端：语音输入已断，可改用文字继续
            except Exception:
                pass

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
            # provider 报错（上游限流/网关抖/超时，重试也没救回）会从 _generate_turn 抛到这里——
            # 此时还停在 THINKING/SPEAKING。绝不能把通话【卡在「思考中」】：回 listening，让用户能接着说。
            log.warning("生成一轮失败，回 listening 不卡死：%r", e)
            await self._recover_to_listening()

    async def _recover_to_listening(self) -> None:
        """一轮异常后把通话从 THINKING/SPEAKING 拉回 LISTENING（正常结束路径在 _generate_turn 末尾，
        但异常会跳过它 → 不补这一手用户就永远停在「思考中」）。本身绝不抛错。"""
        try:
            if self.sm.phase in (Phase.SPEAKING, Phase.THINKING) and self.sm.can(Phase.LISTENING):
                self.sm.to(Phase.LISTENING)
                await self._emit(ServerEvent.state(Phase.LISTENING.value))
        except Exception:
            pass

    # ── task B + C（骨架内联；真实拆成常驻协程经 tts_queue 解耦）──
    async def on_user_text(self, text: str) -> None:
        """文字模式输入 / ASR final 文本 → 触发一轮思考生成+发声。"""
        text = (text or "").strip()
        if not text or self.sm.phase in (Phase.IDLE, Phase.ENDED):
            return
        try:
            async with self._turn_lock:
                await self._generate_turn(text)
        except asyncio.CancelledError:
            pass
        except Exception as e:   # 文字模式同样别卡死在「思考中」
            log.warning("生成一轮失败（文字），回 listening 不卡死：%r", e)
            await self._recover_to_listening()

    def begin_conversation(self) -> None:
        """前端发来 ready（RTC 已真连上 或 已回退 WS）→ 此刻才【开始计时/计费】+ 让 AI 主动开口：
        拨通 loading 期不计费（用户要求）；前端显示时长由 billing.elapsed 驱动，也从此刻才走。
        计费一次性（_billing_task 守卫）；开场再叠加 _greeted/配置/LLM 守卫。重复 ready / 会话已结束安全 no-op。"""
        if self.sm.phase in (Phase.IDLE, Phase.ENDED):
            return
        if self._billing_task is None:   # 接通就绪才起计费/计时（loading 期不计）
            self._billing_task = asyncio.create_task(self._billing_loop())
        if self._greeted or not self._greet_on_start or getattr(self, "llm", None) is None:
            return
        self._greeted = True
        self._greet_task = asyncio.create_task(self._run_opening())

    async def _run_opening(self) -> None:
        """主动说开场白：仅在「还没有任何一轮、仍处 LISTENING」时插入——用户抢先开口（history 非空）
        或已不在可对话态则让位。走 _turn_lock 与用户首轮串行，绝不并发；这句开场用户可随时打断
        （_generate_turn 全程尊重 self._interrupt）。失败静默忽略，照常等用户开口。
        开场全程置 _opening_active → _listen_loop 整段丢 ASR：彻底断掉「AI 把自己开场白当用户插话」的自我打断
        （AEC 热身窗在 RTC 连上即 arm，但开场 LLM+TTS 要 ~1.5s 才出声、热身窗会在开场音频播出前耗尽，故需此兜底）。
        关键：_opening_active 必须保持到音频【真正播完】，不是发完——RTC 下合成远快于播放，_generate_turn 在「音频
        喂进缓冲」即返回时缓冲里还有几秒没播；这段尾巴若解除抑制，开场白回声会触发打断→flush_tts→把开场从中间切断
        （「说到一半声音被切断」）。故用 _audio_until 等到播完再解除。"""
        try:
            async with self._turn_lock:
                # 续接模式即使带着上一通的 history 也要先开口（接住话茬）；非续接则 history 非空=用户已先说→让位。
                if (self.history and not self._continuation) or self.sm.phase != Phase.LISTENING:
                    return
                self._opening_active = True
                try:
                    # 续接重拨：用「续接指令」接着聊、别重新自我介绍；否则每通随机换开场角度+反重复（治开头同一句）。
                    directive = (self._continuation_directive if self._continuation
                                 else _varied_opening(self._opening_directive))
                    await self._generate_turn(directive, opening=True)
                    # 等开场音频真正播完（_audio_until 是已发音频播放到的终点），这段尾巴继续抑制 ASR 防回声切断。
                    tail = self._audio_until - time.monotonic()
                    if tail > 0:
                        await asyncio.sleep(min(tail, 20.0))   # 上限 20s 防异常值卡死（正常开场就几秒）
                finally:
                    self._opening_active = False
                    # 开场说完：若全双工，给随后第一轮对话一个新鲜 AEC 热身窗（开场已占满原热身窗）。
                    if self._full_duplex_aec:
                        self._aec_warmup_until = time.monotonic() + self._aec_warmup_s
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.warning("开场白生成失败（忽略，照常等用户开口）：%r", e)

    async def _embed_query(self, text: str) -> list[float] | None:
        """把本轮用户话向量化用于情节记忆余弦召回。仅配了 Embedding 且库里有可检索记忆时才嵌入，
        否则纯属给实时路径白加一次网络往返（开场/新会话尤其明显，对话发钝）。带紧超时兜底。"""
        t = (text or "").strip()
        if self._embedder is None or not t:
            return None
        if not self._mem_has_facts:
            return None  # 没有可召回的记忆 → 不嵌入，省一次往返（recall 也只会返回空）。开场已缓存，不再每轮查库
        if len(t) < self._embed_min_chars:
            return None  # 短话（嗯/好的/是啊）不嵌入：没语义、召回是噪声，省一次往返让接话更跟手（关键词召回兜底）
        try:
            # 实时路径硬上限：嵌入慢/卡也不拖累对话，超时即退关键词召回。让「说完→AI接话」更跟手，
            # 嵌入正常都 <embed_timeout_s（不影响召回质量），只有真卡时才快速降级关键词。
            return await asyncio.wait_for(self._embedder.embed_one(t), timeout=self._embed_timeout_s)
        except Exception as e:  # 超时/网络/鉴权：静默退关键词召回（asyncio.TimeoutError 也是 Exception）。
            log.warning("query 向量化跳过（超时/失败），退关键词召回：%r", e)
            return None

    async def _generate_turn(self, user_text: str, *, opening: bool = False) -> None:
        self._interrupt.clear()
        # 注意：回声基准 _ai_said 不在此清空——上一轮 AI 的音频可能还在前端缓冲播放，
        # 思考阶段(THINKING)仍要靠它拦住拖尾回声；等真正开口(open_speak)再以本轮文本重置。
        # opening=主动开场：没有用户话，不上「user 字幕」、不把指令写进 history（避免污染上下文）。
        if not opening:
            await self._emit(ServerEvent.subtitle("user", user_text))
            self.history.append({"role": "user", "content": user_text})

        self.sm.to(Phase.THINKING)
        await self._emit(ServerEvent.state(Phase.THINKING.value))

        _t0 = time.monotonic()   # ⏱ 诊断埋点：从「触发本轮」起算各阶段耗时，定位延迟卡在哪一跳
        qvec = None if opening else await self._embed_query(user_text)  # 开场无用户话可嵌入；否则配了 Embedding 才算
        messages = self.assembler.build(
            character_id=self.character_id, scenario=self.scenario_prompt, history=self.history,
            query_vector=qvec,
        )
        if opening:
            # 开场指令作为临时 user 消息只喂这一次 LLM（不入 history、不上字幕），让 AI 据系统提示里的
            # 开场上下文（关系/上次/间隔/心情/节日）自然先开口。history 为空 → assembler 已判定为 opening 轮。
            messages = [*messages, {"role": "user", "content": user_text}]
        log.info("⏱ 召回嵌入 %.0fms", (time.monotonic() - _t0) * 1000)
        self._usage["llm_in_chars"] += sum(len(str(m.get("content", ""))) for m in messages)  # 成本：LLM 输入
        spoke: list[str] = []   # 实际播出的句子（清洗后的人话）→ 进上下文（§1.5）
        buf = ""
        started = False
        cur_emotion = "neutral"          # 逐句情绪「继承」：LLM 只在情绪变化时打标签，没打就沿用上一句（更省更稳）
        jobs: list[dict] = []            # 已切出的句子任务（按序）：含情绪 + 韵律 + TTS 文本 + 字幕文本
        prefetch: list = []              # jobs[1:] 的预合成任务（与首句播放并行，消除句间空档）
        play0 = None                     # 首句抢跑播放任务

        async def _open_speaking(first_emotion: str) -> None:
            nonlocal started
            if started:
                return
            self._ai_said = ""  # 进入发声：以本轮 AI 文本作为新的回声基准（此前保留上一轮防拖尾回声）
            self.emotion_tag = first_emotion
            self.sm.to(Phase.SPEAKING)
            await self._emit(ServerEvent.state(Phase.SPEAKING.value))
            started = True

        def _make_job(sentence: str) -> dict | None:
            """一句 → 情绪 + 韵律 + TTS 文本(留拟声/停顿) + 字幕文本(纯人话)。整句全是旁白/标签则 None。"""
            nonlocal cur_emotion
            emo, body = take_sentence_emotion(sentence, cur_emotion)
            cur_emotion = emo
            tts_text, sub_text = clean_for_tts(body), clean_for_subtitle(body)
            tts_text = humanize_for_tts(tts_text, emo)   # 「哈哈」→(laughs)、「唉」→(sighs) 真人声（字幕不动）
            if not tts_text and not sub_text:
                return None
            m_emo, speed, pitch, vol = prosody_for(emo, self.emotion_map)
            return {"emotion": emo, "speed": speed, "pitch": pitch, "vol": vol, "tts": tts_text, "sub": sub_text}

        _first_token = True
        async with aclosing(self.llm.stream(messages, max_tokens=self._reply_max_tokens)) as llm_gen:
            _it = llm_gen.__aiter__()
            while True:
                try:
                    if _first_token:
                        token = await asyncio.wait_for(_it.__anext__(), timeout=self._llm_first_token_timeout)
                    else:
                        token = await _it.__anext__()
                except StopAsyncIteration:
                    break
                except asyncio.TimeoutError:
                    log.warning("LLM 首 token 超时 %.1fs，放弃本轮（防卡死，下方兜底回 listening）",
                                self._llm_first_token_timeout)
                    break
                if self._interrupt.is_set():
                    break
                if _first_token:
                    _first_token = False
                    log.info("⏱ LLM首token %.0fms", (time.monotonic() - _t0) * 1000)
                buf += token
                # 切出所有已成形的完整句，逐句带情绪入流水线
                while True:
                    sent, rest = _take_first_sentence(buf)
                    if not sent:
                        break
                    buf = rest
                    job = _make_job(sent)
                    if job is None:
                        continue
                    if not jobs:
                        jobs.append(job)
                        log.info("⏱ 首句成形 %.0fms", (time.monotonic() - _t0) * 1000)
                        await _open_speaking(job["emotion"])
                        play0 = asyncio.create_task(self._speak_job(job, None, spoke))  # 首句抢跑：流式合成
                    else:
                        jobs.append(job)
                        prefetch.append(asyncio.create_task(self._synth_buffer(job)))   # 后续句：边播首句边预合成

        tail = buf.strip()
        if tail and not self._interrupt.is_set():
            job = _make_job(tail)
            if job is not None:
                if not jobs:
                    jobs.append(job)
                    await _open_speaking(job["emotion"])
                    play0 = asyncio.create_task(self._speak_job(job, None, spoke))
                else:
                    jobs.append(job)
                    prefetch.append(asyncio.create_task(self._synth_buffer(job)))

        # 首句播完后，按序播放已预合成好的后续句（缓冲就绪 → 无缝衔接，不留「句间自我打断」的空档）。
        if play0 is not None:
            try:
                await play0
            except Exception as e:  # 单句发声异常绝不断整轮
                log.warning("首句发声异常：%r", e)
        for k in range(1, len(jobs)):
            if self._interrupt.is_set():
                break
            try:
                audio = await prefetch[k - 1]
            except Exception as e:
                log.warning("预合成异常（该句无音频，不断话）：%r", e)
                audio = b""
            await self._speak_job(jobs[k], audio, spoke)
        for t in prefetch:   # 被打断/出错：取消还没用上的预合成，省成本
            if not t.done():
                t.cancel()

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

    async def _synth_buffer(self, job: dict) -> bytes:
        """后续句的「预合成」：在首句还在播时，把这句带情绪+韵律一次合成进缓冲，等轮到它即刻无缝放出。
        合成失败/被打断 → 返回已得部分（绝不抛错断整轮）。"""
        if not job.get("tts"):
            return b""
        chunks: list[bytes] = []
        try:
            async with aclosing(self.tts.synthesize(
                job["tts"], voice_id=self.voice_id, emotion=job["emotion"],
                speed=job["speed"], pitch=job["pitch"], vol=job["vol"],
            )) as gen:
                async for c in gen:
                    if self._interrupt.is_set():
                        break
                    chunks.append(c)
        except Exception as e:
            log.warning("预合成失败（该句仅丢音频，不断话）：%r", e)
        return b"".join(chunks)

    async def _speak_job(self, job: dict, audio: bytes | None, spoke: list[str]) -> None:
        """发一句：先亮字幕(纯人话) + 切该句情绪的脸，再放音频。audio=None → 首句流式合成(抢跑)；
        audio=bytes → 后续句的预合成缓冲，分块放出。任何异常都吞掉（不断整轮，§无回退靠健壮兜底）。"""
        if self._interrupt.is_set():
            return  # 已被打断：这句不发、不进上下文（§1.5 难点4）
        sub, tts_text = job.get("sub", ""), job.get("tts", "")
        # 这句的情绪同步驱动「脸」（逐句切表情，比整轮一个表情更生动）。
        await self._emit(ServerEvent.emotion(job["emotion"]))
        self.emotion_tag = job["emotion"]
        if sub:
            # 这句的预估说出时长：有预合成音频(后续句)→ 按 PCM 字节算(24kHz s16 mono=48000 B/s)，最准；
            # 首句是流式抢跑、此刻还没有字节→按字数估(中文约 5 字/秒)。前端据此在该时长内逐字揭开字幕。
            dur = (len(audio) / 48000.0) if audio else max(0.6, len(sub) * 0.2)
            await self._emit(ServerEvent.subtitle("ai", sub, dur=dur))
            self._ai_said += sub  # 回声基准（按真正说出的人话，不含拟声/停顿标记）
        if not tts_text:
            if sub:
                spoke.append(sub)
            return
        self._usage["tts_chars"] += len(tts_text)   # 成本：TTS 合成字符
        if self._audio_emit is None:   # 文字/测试模式：不出音频，只记上下文
            spoke.append(sub or tts_text)
            return
        audio_bytes = 0
        _ts = time.monotonic()
        _first_chunk = True
        try:
            if audio is None:
                # 首句抢跑：流式合成边出边播（最低首音延迟）。打断时 aclosing 立刻掐断合成。
                async with aclosing(self.tts.synthesize(
                    tts_text, voice_id=self.voice_id, emotion=job["emotion"],
                    speed=job["speed"], pitch=job["pitch"], vol=job["vol"],
                )) as gen:
                    async for chunk in gen:
                        if self._interrupt.is_set():
                            return
                        if chunk:
                            if _first_chunk:
                                _first_chunk = False
                                log.info("⏱ TTS首块 %.0fms（合成首字节）", (time.monotonic() - _ts) * 1000)
                            await self._audio_emit(chunk)
                            audio_bytes += len(chunk)
            else:
                # 后续句：预合成缓冲，分块放出（已就绪 → 紧接上一句、无空档）。
                for i in range(0, len(audio), _AUDIO_CHUNK):
                    if self._interrupt.is_set():
                        return
                    piece = audio[i:i + _AUDIO_CHUNK]
                    if piece:
                        await self._audio_emit(piece)
                        audio_bytes += len(piece)
        except Exception as e:
            log.warning("发声异常（跳过该句，不断话）：%r", e)
        # 估计这句在前端播放到的时刻（24kHz 16bit 单声道）→ 回声判定时间窗。
        dur = audio_bytes / (24000 * 2)
        self._audio_until = max(time.monotonic(), self._audio_until) + dur + self._play_pad
        if audio_bytes == 0 and tts_text:
            # 有文本却 0 字节 = 这句完全没出声。打 ERROR 点名最可能原因，让「没声音」在日志里一眼可见、可 grep。
            log.error("⚠ 本句 0 字节、没出声！voice=%s —— TTS 上游没返回音频（连接变质/鉴权/余额）。"
                      "连接变质类已加连接池自愈；若反复出现请查 key/余额或看 boot 日志是否 tts→StubTTS", self.voice_id)
        log.info("⟶ 句音频 %d bytes（emo=%s spd=%.2f pit=%d voice=%s）",
                 audio_bytes, job["emotion"], job["speed"], job["pitch"], self.voice_id)
        if sub:
            spoke.append(sub)  # 整句播完 → ack 边界（进上下文用纯人话）

    # ── 打断（§1.5：停下行 → 清队列 → cancel → 半截话进上下文 → 回 listening）──
    async def interrupt(self) -> None:
        if self.sm.phase not in (Phase.THINKING, Phase.SPEAKING):
            return
        self._interrupt.set()                 # task B/C 在 token/句边界退出
        # 打断即停播（前端 flush TTS）→ 立刻关回声守卫窗：否则 _audio_until 仍指向「本该播完的时刻」，
        # 那段时间用户【打断后说的话】会被 now<=_audio_until 的模糊重叠判成回声、吞掉开头。
        self._audio_until = time.monotonic()
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
        # 切场景：更新喂 LLM 的情境（assembler 下轮读取）；记录标签 self.scenario 不动（统计稳定）。画面不变（固定背景）。
        self.scenario_prompt = scene

    def set_client_timezone(self, offset_min) -> None:
        """前端 ready 下发客户端 UTC 偏移分钟 → 让「现在几点」按用户本地时区算。转交 assembler。"""
        try:
            self.assembler.set_client_timezone(offset_min)
        except Exception as e:  # 容错：时区下发失败绝不影响通话，退 UTC+8
            log.warning("set_client_timezone 失败，按 UTC+8：%r", e)

    def set_full_duplex(self, on: bool) -> None:
        """RTC 媒体面连上/断开 → 标记是否处于全双工硬件 AEC。
        连上(on=True)：AEC 减弱回授，适度把打断门槛 4→3（短插话更跟手）；但回声判定【始终保留】，不放开
        ——否则 AEC 漏进来的 AI 余音会被当插话「自我打断」。退回 WS(on=False)：门槛回 4。"""
        if on != self._full_duplex_aec:
            log.info("全双工硬件 AEC → %s（打断门槛=%d，回声判定始终保留防自我打断）",
                     "on" if on else "off",
                     self._bargein_min_chars_aec if on else self._bargein_min_chars)
            if on:
                # 刚连上 → 开热身窗：这 ~1.8s 内 AEC 在收敛，AI 在播时录到的余音不靠谱，先不当用户说话。
                self._aec_warmup_until = time.monotonic() + self._aec_warmup_s
        self._full_duplex_aec = bool(on)

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
        try:
            self._mic_q.put_nowait(None)    # 哨兵：让 _mic_frames 收尾 → ASR 流自然结束
        except asyncio.QueueFull:           # 队列满（有界）：腾一帧再放哨兵，保证收尾不丢
            try:
                self._mic_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._mic_q.put_nowait(None)
        # 收掉计费 / task A / 当前一轮（避免它们在挂断后还往已关连接下行）。
        tasks = [self._billing_task, self._listen_task, self._current_turn, self._greet_task]
        self._billing_task = self._listen_task = self._current_turn = self._greet_task = None
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

    def _trim_history(self, max_turns: int | None = None) -> None:
        # 通话内滑窗（条数）。太短(12/6 轮)长聊会忘事；太长(30/15 轮)长聊每轮喂快脑的历史越堆越大→首字越慢、
        # 「越聊越卡」。默认收到 20 条(10 轮)平衡连贯与提速，更久远上下文交给 L3 记忆召回兜底；可经
        # global_defaults.incall_max_turns 调。assembler 还会按 budget_chars 再裁一道。
        cap = self._incall_max_turns if max_turns is None else max_turns
        if len(self.history) > cap:
            self.history = self.history[-cap:]
