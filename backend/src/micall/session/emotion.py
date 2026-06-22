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

# 容错匹配开头的情绪标签：模型常把 key 写成 emotion/mood/feeling/情绪/心情，tag 可中可英。
# 之前只认 [emotion:...]，模型吐 [mood:tender] 就漏过 → 被念出来/显示出来（用户实测）。
_PREFIX = re.compile(
    r"^\s*[\[【(（]\s*(?:emotion|mood|feeling|情绪|心情|语气)\s*[:：]\s*"
    r"([a-zA-Z_一-鿿][\w一-鿿]*)\s*[\]】)）]\s*",
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
