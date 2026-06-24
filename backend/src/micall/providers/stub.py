"""Stub 供应商 —— 零外部依赖，用于骨架运行与单元测试。

不连任何外部服务，产出确定性内容，驱动同一套会话编排状态机与信令协议。接真实供应商
只需在 providers/__init__.py 的工厂按 NodeConfig.configured 切换，对话逻辑不动（铁律2/§1.7）。
StubLLM 的回复刻意带 `[emotion:tag]` 前缀且含句末标点，用于验证情绪 piggyback 解析（§2.1）
与 task B 的句子级切分/首句抢跑（§1.3）。
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator, Sequence

from .base import ASRProvider, LLMProvider, Message, TTSProvider

# 这是「stub 服务端」在说话，不是前端假装对话；真实后端由 LLM 产出。
_STUB_REPLIES: list[str] = [
    "[emotion:tender] 嗯，我在听。今天过得怎么样？",
    "[emotion:caring] 别急，慢慢说，我陪着你。",
    "[emotion:tender] 我懂，那一定挺累的。把心里的话说出来吧。",
    "[emotion:caring] 你今天，已经很努力了。",
]


class StubLLM(LLMProvider):
    def __init__(self, replies: Sequence[str] | None = None) -> None:
        self._replies = list(replies) if replies else _STUB_REPLIES
        self._turn = 0

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.8, max_tokens: int = 256
    ) -> AsyncIterator[str]:
        reply = self._replies[self._turn % len(self._replies)]
        self._turn += 1
        # 按字符块产出，模拟流式 token（让出事件循环，便于打断在 token 边界生效）。
        for ch in reply:
            await asyncio.sleep(0)
            yield ch


class StubTTS(TTSProvider):
    async def synthesize(
        self, text: str, *, voice_id: str, emotion: str = "",
        speed: float = 1.0, pitch: int = 0, vol: float = 1.0,
        sample_rate: int = 24000, audio_format: str = "pcm",
    ) -> AsyncIterator[bytes]:
        # 每个字产出一小块「音频」，时长正比于文本（仅用于编排/计费骨架，非真实音频）。
        for _ in text:
            await asyncio.sleep(0)
            yield b"\x00\x00"


class StubASR(ASRProvider):
    async def stream(self, frames: AsyncIterator[bytes]) -> AsyncIterator[tuple[str, bool]]:
        # 骨架不做真实转写：把上行帧计数作 partial，收尾给 final 空串。真实接百炼 Qwen3-ASR。
        n = 0
        async for _ in frames:
            n += 1
            if n % 25 == 0:
                yield (f"(stub partial {n})", False)
        yield ("", True)
