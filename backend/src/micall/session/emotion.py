"""情绪标签 piggyback（docs/02 §2.1 + CLAUDE.md 铁律4：一处产生、多处消费）。

LLM 生成回复时顺带吐情绪标签，**不额外调用 LLM**（铁律5：实时路径绝不加 LLM 往返）。
约定输出形如 `[emotion:tender] 实际回复……`。解析出 tag 后：
  • 剥离前缀，文本送 TTS；
  • tag 查 voice.emotion_map → MiniMax emotion 参数（服务端用）；
  • tag 经 {"type":"emotion"} 信令下发前端 → 切对应情绪循环视频。
一个标签，驱动声音与脸。
"""
from __future__ import annotations

import re

# 容错匹配开头的情绪标签。实测模型有三种乱法都会漏进字幕/被念出来：
#   ① 标准 [emotion:tender]；② 省略 key 直接 [caring]/[listening]；③ 把 key 拼错，如 [eomotion:idle]。
# 故【不再写死 key 列表】——开头方括号 = 标签残留（人设本就禁止写括号/旁白），一律剥掉：
#   接受「[ 可选的任意短 key： ] 标签」与「[ 标签 ]」两种形态，key 拼对拼错都吃掉。
_PREFIX = re.compile(
    r"^\s*[\[【(（]\s*"
    r"(?:[a-zA-Z_一-鿿]{1,12}\s*[:：]\s*)?"          # 可选 key：（含拼错的 emotion，如 eomotion/emo/emotion）
    r"([a-zA-Z_一-鿿][\w一-鿿]{0,20})\s*[\]】)）]\s*",
    re.IGNORECASE,
)
DEFAULT_EMOTION = "neutral"


def split_emotion(text: str, default: str = DEFAULT_EMOTION) -> tuple[str, str]:
    """从回复文本前缀剥离情绪标签。无标签则返回 (default, 原文)。纯函数，便于测试。"""
    m = _PREFIX.match(text)
    if not m:
        return default, text
    return m.group(1), text[m.end():]


class EmotionStripper:
    """流式版：逐 token 喂入，先攒够开头的情绪标签（[emotion:tag]/[mood:tag]…）再放行后续文本。

    task B 边流式生成边切句，需要在首个 token 起就把标签剥掉，避免标签混进 TTS 文本。
    """

    def __init__(self, default: str = DEFAULT_EMOTION) -> None:
        self.tag = default
        self._buf = ""
        self._resolved = False
        self._lstrip_pending = False  # 标签在 `]` 处即解析，但其后空格可能在后续 token 才到

    def feed(self, token: str) -> str:
        """喂一个 token，返回应向下游输出的文本（标签未定时先缓冲、返回空串）。"""
        if self._resolved:
            if self._lstrip_pending:
                token = token.lstrip()
                if token:
                    self._lstrip_pending = False
            return token
        self._buf += token
        m = _PREFIX.match(self._buf)
        if m:
            self.tag = m.group(1)
            self._resolved = True
            rest = self._buf[m.end():]
            if not rest.strip():  # 标签后暂时只有空白：吞掉，待后续 token 再 lstrip
                self._lstrip_pending = True
                return ""
            return rest
        # 还可能是标签：以 [/【/( 开头、还没遇到闭括号、且不太长 → 继续缓冲等闭括号。
        head = self._buf.lstrip()
        if head and head[0] in "[【(（" and not any(c in head for c in "]】)）") and len(head) < 28:
            return ""
        # 不是标签（或格式不符）→ 整体透传。
        self._resolved = True
        return self._buf

    def flush(self) -> str:
        """流结束时取出尚在缓冲、未识别为标签的残留文本。"""
        if self._resolved:
            return ""
        self._resolved = True
        return self._buf


# ─────────────────────── 逐句情绪 + 韵律（让 AI 说话带情绪，非平铺直叙）───────────────────────
# 设计：LLM 逐句吐情绪标签 + 在正文里插拟声/停顿；后端按「情绪→韵律预设」算 speed/pitch/vol（LLM 不吐数字，
# 避免逐句数字抖动=「像换人」）。MiniMax 仅认 6 种 emotion 枚举，非枚举情绪（tender/playful…）靠 speed/pitch 做。

# 情绪标签 → (MiniMax 语义情绪, speed[0.5-2], pitch[-12~12 整], vol[0-10])。初版凭直觉，留真机听调。
# emotion 这一列交给 minimax 层再映射到其 6 枚举；非枚举（""）则只靠韵律实现。
# 关键：pitch 一律 0。改音高=换音色=「像换了个人」（用户实测踩坑）。情绪只走「同一个人」也保得住的三样：
#   ① MiniMax emotion 枚举（同一音色、换情绪化念法）② 语速快慢（同一个人说快说慢）③ 真实笑/叹拟声。
# 这样能听出情绪、又绝不变成另一个人。speed/vol 在合法区间且取温和值（别太极端，极端也会怪）。
_PROSODY: dict[str, tuple[str, float, int, float]] = {
    "neutral":   ("neutral", 1.00, 0, 1.0),
    "tender":    ("", 0.96, 0, 1.0),       # 温柔：略慢
    "caring":    ("", 0.94, 0, 1.0),       # 关切：略慢
    "gentle":    ("", 0.95, 0, 1.0),
    "happy":     ("happy", 1.08, 0, 1.0),  # 开心：枚举 + 略快
    "excited":   ("happy", 1.12, 0, 1.1),  # 兴奋：更快、略响
    "playful":   ("happy", 1.10, 0, 1.0),  # 俏皮/撒娇：快一点
    "shy":       ("", 0.95, 0, 0.95),      # 害羞：略慢略轻
    "sad":       ("sad", 0.90, 0, 1.0),    # 难过：枚举 + 放慢
    "comfort":   ("sad", 0.86, 0, 0.95),   # 安慰：更慢更柔
    "calm":      ("", 0.92, 0, 1.0),
    "angry":     ("angry", 1.08, 0, 1.2),  # 生气：略快、响
    "fearful":   ("fearful", 1.06, 0, 1.0),
    "worried":   ("fearful", 0.95, 0, 1.0),
    "surprised": ("surprised", 1.10, 0, 1.1),  # 惊讶：略快
    "disgusted": ("disgusted", 0.96, 0, 1.0),
}


def prosody_for(tag: str) -> tuple[str, float, int, float]:
    """情绪标签 → (emotion, speed, pitch, vol)。未知标签回退中性（安全：等于现状）。"""
    return _PROSODY.get((tag or "").strip().lower(), _PROSODY["neutral"])


# MiniMax 2.8-turbo 支持的拟声/气口标签（正文内行内）：喂 TTS 念成真实的笑/叹/呼吸声，但不进字幕。
_INTERJECTIONS = frozenset({
    "laughs", "laugh", "chuckle", "chuckles", "coughs", "cough", "clear-throat", "groans",
    "groan", "breath", "breathe", "pant", "pants", "inhale", "exhale", "gasps", "gasp",
    "sniffs", "sniff", "sighs", "sigh", "snorts", "snort", "burps", "lip-smacking",
    "humming", "hissing", "emm", "sneezes", "sneeze",
})
_PAUSE = re.compile(r"<#\s*\d+(?:\.\d+)?\s*#>")                # MiniMax 停顿标记 <#0.4#>
_EN_PAREN = re.compile(r"\(\s*([a-zA-Z][a-zA-Z\- ]*)\s*\)")     # 英文括号（可能是拟声标签）
_CN_ACTION = re.compile(r"（[^）]*）|【[^】]*】|\*[^*]*\*")        # 中文旁白/动作/星号：一律去掉
_ALL_EMOTION_TAGS = re.compile(                                  # 句中任意位置的方括号标注残留（情绪标签 / 舞台说明）
    # tag 内容允许【空格】：模型有时把拟声/旁白写成多词方括号（如 [laughs softly]），原来不含空格会漏进字幕。
    # 仍以字母/汉字开头（数字开头如 [8:30] 不当标签，不误伤时间）。
    r"[\[【]\s*(?:[a-zA-Z_一-鿿]{1,12}\s*[:：]\s*)?[a-zA-Z_一-鿿][\w一-鿿 ]{0,30}\s*[\]】]"
)
# 模型有时把笑/叹写成【方括号多词】形式（[laughs softly]/[sighs]）：既漏进字幕、又不被 MiniMax 当拟声念。
# 送 TTS 前把这类转成 MiniMax 认的拟声 (laughs)/(sighs)，让她真笑真叹；字幕侧则由上面的标签清洗一并去掉。
_BRACKET_LAUGH = re.compile(r"[\[【]\s*(?:laugh|chuckl|giggl|haha|hehe|grin)[\w \-]*[\]】]", re.IGNORECASE)
_BRACKET_SIGH = re.compile(r"[\[【]\s*(?:sigh|exhale)[\w \-]*[\]】]", re.IGNORECASE)


def _keep_interjection(m: "re.Match[str]") -> str:
    """英文括号：是 MiniMax 认的拟声标签就保留（喂 TTS），否则当旁白去掉。"""
    word = m.group(1).strip().lower()
    return m.group(0) if word in _INTERJECTIONS else ""


def clean_for_tts(text: str) -> str:
    """送 TTS 的文本：保留拟声标签 (sighs) 与停顿 <#x#>（MiniMax 会发声/停顿），去掉中文旁白与非法英文括号。
    情绪标签由调用方先 split 掉，这里再兜底去残留。"""
    t = _BRACKET_LAUGH.sub("(laughs)", text or "")   # [laughs softly] 等方括号笑 → 真笑拟声
    t = _BRACKET_SIGH.sub("(sighs)", t)              # [sighs]/[exhale] 等 → 真叹气
    t = _ALL_EMOTION_TAGS.sub("", t)                 # 其余方括号标注（情绪/舞台说明）清掉
    t = _CN_ACTION.sub("", t)
    t = _EN_PAREN.sub(_keep_interjection, t)
    return t.strip()


def clean_for_subtitle(text: str) -> str:
    """送字幕的文本：纯人话——情绪标签、拟声标签、停顿标记、中文旁白全部去掉（用户不该看到 (sighs)/<#0.3#>）。"""
    t = _ALL_EMOTION_TAGS.sub("", text or "")
    t = _PAUSE.sub("", t)
    t = _CN_ACTION.sub("", t)
    t = _EN_PAREN.sub("", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def take_sentence_emotion(sentence: str, default: str) -> tuple[str, str]:
    """从一句（可能带前缀情绪标签）剥出情绪并返回正文。无标签则继承 default（让 LLM 只在情绪变化时打标签，更省更稳）。"""
    m = _PREFIX.match(sentence or "")
    if m:
        return m.group(1), sentence[m.end():]
    return default, (sentence or "")


# 安全网 + 高频真人感：模型在情绪化口语里本就高频写「哈哈」「唉」这类文字反应，但 TTS 把它们当字念、
# 不像真笑/真叹。这里按情绪把这些文字反应就地换成 MiniMax 拟声，让语音真的笑/叹出来——频率随模型的
# 自然表达走（它写得越多、真人声越密）。只动送 TTS 的文本，不动字幕（用户仍看到「哈哈」「唉」）。
_LAUGH_RUN = re.compile(r"(?:哈|嘻|嘿){2,}|哈哈+")
_LAUGH_EMOTIONS = frozenset({"happy", "excited", "playful", "neutral", "tender", "caring"})
_SIGH_RUN = re.compile(r"唉+")
_SIGH_EMOTIONS = frozenset({"sad", "comfort", "caring", "worried", "calm", "tender", "gentle", "neutral"})
# 明确「被逗乐」的标志：开心情绪下若出现这些词、却没写出笑 → 句尾补一个真笑（让支持拟声的音色笑出来）。
_AMUSED_CUE = re.compile(r"太逗|逗死|笑死|乐死|太好玩|太搞笑|笑喷|绝了|有意思|好玩")
_AMUSED_EMOTIONS = frozenset({"happy", "excited", "playful"})


def humanize_for_tts(tts_text: str, emotion: str) -> str:
    """把模型自然写出的文字反应换成真实人声拟声：正向情绪「哈哈/嘻嘻」→ (laughs)；低落/温柔情绪「唉」→ (sighs)。
    让 AI 像真人那样高频地真笑、真叹，而不是把"哈哈""唉"当字念。只动 TTS 文本，字幕不动。"""
    e = (emotion or "").strip().lower()
    t = tts_text or ""
    if e in _LAUGH_EMOTIONS:
        t = _LAUGH_RUN.sub("(laughs)", t)
    if e in _SIGH_EMOTIONS:
        t = _SIGH_RUN.sub("(sighs)", t)
    if e in _AMUSED_EMOTIONS and "(laughs)" not in t and _AMUSED_CUE.search(t):
        t = t + "(laughs)"   # 被逗乐却没写出笑 → 句尾真笑一下
    return t

