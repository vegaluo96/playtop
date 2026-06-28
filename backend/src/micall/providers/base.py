"""供应商抽象接口（docs/02 §1.2：各节点可插拔，对应 Admin「接口配置」）。

实时三节点：ASR（流式转写）、LLM 快脑（流式 token）、TTS（流式音频）。
真实实现按节点 endpoint/key（铁律2）接 apiyi / 阿里百炼 / MiniMax；骨架与测试用 stub。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator, Sequence

# LLM 对话消息（OpenAI/DeepSeek 风格）。
Message = dict  # {"role": "system"|"user"|"assistant", "content": str}


class LLMProvider(ABC):
    """快脑：流式吐 token（docs/02 §1.3 task B）。TTFT 是延迟主瓶颈（§1.7）。"""

    @abstractmethod
    def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.8, max_tokens: int = 256,
        response_format: dict | None = None,
    ) -> AsyncIterator[str]:
        """逐 token 异步产出。实现为 `async def ... yield`。
        response_format：仅离线·要 JSON 的调用点传 {"type":"json_object"}（理解/自主/AI生成），
        让模型只吐合法 JSON、少掉解析失败；实时口语路径不传（自由文本）。"""
        raise NotImplementedError


class TTSProvider(ABC):
    """发声：句子级流式合成（docs/02 §1.3 task C），带 emotion 与 voice_id。"""

    @abstractmethod
    def synthesize(
        self, text: str, *, voice_id: str, emotion: str = "",
        speed: float = 1.0, pitch: int = 0, vol: float = 1.0,
        sample_rate: int = 24000, audio_format: str = "pcm",
    ) -> AsyncIterator[bytes]:
        """逐音频块异步产出。emotion/speed/pitch/vol 让 AI 说话带情绪（韵律由编排层按情绪预设算好传入）。
        audio_format：实时通话用 "pcm"（前端 Web Audio 直接播，H5/iOS 稳）；试听存档用 "mp3"。"""
        raise NotImplementedError


class ASRProvider(ABC):
    """感知：流式转写（docs/02 §1.3 task A）。产出 (text, is_final)。"""

    @abstractmethod
    def stream(self, frames: AsyncIterator[bytes]) -> AsyncIterator[tuple[str, bool]]:
        """吃 20ms 音频帧流，产出 (partial_or_final_text, is_final)。"""
        raise NotImplementedError
