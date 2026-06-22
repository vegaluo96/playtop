"""真实 TTS provider —— MiniMax T2A v2（官方直连，emotion + voice_id，docs/02 节点）。

endpoint/key 全配置（铁律2）。endpoint 形如 https://api.minimax.chat/v1/t2a_v2?GroupId=xxx
（GroupId 拼在 query 里）。骨架先用非流式（整段合成）验证音色；真实通话用流式句子级，
接入点同此类，把 stream 打开按 SSE 收 hex 音频块即可。需 httpx；未配置时工厂回退 StubTTS。
"""
from __future__ import annotations

from typing import AsyncIterator

from ..config import NodeConfig
from .base import TTSProvider

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


class MiniMaxTTS(TTSProvider):
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("MiniMaxTTS 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self.node = node
        self.model = node.params.get("model", "speech-2.8-turbo")

    async def synthesize(
        self, text: str, *, voice_id: str, emotion: str = "", sample_rate: int = 24000
    ) -> AsyncIterator[bytes]:  # pragma: no cover （需真实网络/密钥）
        vid = voice_id or self.node.params.get("default_voice", "")
        body: dict = {
            "model": self.model,
            "text": text,
            "stream": False,
            "voice_setting": {"voice_id": vid, "speed": 1.0, "vol": 1.0, "pitch": 0},
            "audio_setting": {"sample_rate": sample_rate, "format": "mp3", "channel": 1},
        }
        if emotion:
            body["voice_setting"]["emotion"] = emotion  # 情绪 piggyback → MiniMax emotion
        headers = {
            "Authorization": f"Bearer {self.node.api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            resp = await client.post(self.node.endpoint, headers=headers, json=body)
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code} · {resp.text[:400]}")
            data = resp.json()
            audio_hex = (data.get("data") or {}).get("audio", "")
            if not audio_hex:
                # MiniMax 失败时把 base_resp 带出来便于排查（如 invalid voice_id / 余额）。
                raise RuntimeError(f"无音频返回 · {str(data)[:400]}")
            yield bytes.fromhex(audio_hex)
