"""真实 ASR provider —— 阿里云百炼 Qwen3-ASR-Flash（OpenAI 兼容模式，整段录音识别）。

compatible-mode 的 chat/completions：把整段音频 base64 成 data URI 放进 input_audio，
模型转写成文字（流式时在 choices[0].delta.content 逐块吐字）。endpoint/key 全配置（铁律2）。

分层很重要：
  • 本类是「整段录音识别」—— 音频要先收齐再上传，适合「用户说完一句 → 转写」与延迟实测。
  • 真·边说边出字的实时流式（§1.4 end-of-turn 抢跑）走另一套 WebSocket 协议
    （qwen-real-time-speech-recognition / paraformer-realtime），后续接 task A 时再上。

端点（区与 key 绑定，不可混用）：
  • 北京区  https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
  • 新加坡区 https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions（离香港近，跨境更快）

需 httpx；未配置时工厂回退 StubASR。
"""
from __future__ import annotations

import base64
import json
from typing import AsyncIterator

from ..config import NodeConfig
from .base import ASRProvider

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


def _data_uri(audio: bytes, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(audio).decode()


def _delta_text(delta: object) -> str:
    """兼容 content 为字符串或分段列表两种返回形态。"""
    if isinstance(delta, str):
        return delta
    if isinstance(delta, list):
        return "".join(
            seg.get("text", "") for seg in delta if isinstance(seg, dict)
        )
    return ""


class BailianASR(ASRProvider):
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("BailianASR 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self.node = node
        self.model = node.params.get("model", "qwen3-asr-flash")

    async def transcribe(
        self, audio: bytes, *, mime: str = "audio/mpeg"
    ) -> AsyncIterator[tuple[str, bool]]:  # pragma: no cover （需真实网络/密钥）
        """整段录音识别：base64 上传 → 流式吐文字。产出 (累计文本, is_final)，与 stream() 同形。"""
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": [{"type": "text", "text": ""}]},
                {
                    "role": "user",
                    "content": [
                        {"type": "input_audio", "input_audio": {"data": _data_uri(audio, mime)}}
                    ],
                },
            ],
            "stream": True,
        }
        headers = {
            "Authorization": f"Bearer {self.node.api_key}",
            "Content-Type": "application/json",
        }
        text = ""
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            async with client.stream(
                "POST", self.node.endpoint, headers=headers, json=body
            ) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode("utf-8", "ignore")[:400]
                    raise RuntimeError(f"HTTP {resp.status_code} · {detail}")
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError, ValueError):
                        continue
                    seg = _delta_text(delta)
                    if not seg:
                        continue
                    # 兼容两种流式语义：增量 delta（拼接）与累计整段（每次重发全文，替换）。
                    # 累计式时新块以已得文本为前缀 → 直接替换，避免拼成两遍。
                    text = seg if seg.startswith(text) else text + seg
                    yield text, False
        yield text, True

    async def stream(
        self, frames: AsyncIterator[bytes]
    ) -> AsyncIterator[tuple[str, bool]]:  # pragma: no cover
        """整段路径下的 task A 适配：收齐上行帧 → 一次识别。真·实时流式后续走 WS 协议另接。"""
        buf = bytearray()
        async for f in frames:
            buf += f
        async for item in self.transcribe(bytes(buf), mime="audio/wav"):
            yield item
