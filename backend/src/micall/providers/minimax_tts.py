"""真实 TTS provider —— MiniMax T2A v2（官方直连，emotion + voice_id，docs/02 节点）。

endpoint/key 全配置（铁律2）。endpoint 形如 https://api.minimax.chat/v1/t2a_v2?GroupId=xxx
（GroupId 拼在 query 里）。骨架先用非流式（整段合成）验证音色；真实通话用流式句子级，
接入点同此类，把 stream 打开按 SSE 收 hex 音频块即可。需 httpx；未配置时工厂回退 StubTTS。
"""
from __future__ import annotations

import json
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
        """句子级流式合成：stream=true，按 SSE 收 hex 音频块，首块一出即可下行（§1.7）。"""
        vid = voice_id or self.node.params.get("default_voice", "")
        body: dict = {
            "model": self.model,
            "text": text,
            "stream": True,
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
            async with client.stream(
                "POST", self.node.endpoint, headers=headers, json=body
            ) as resp:
                if resp.status_code >= 400:
                    detail = (await resp.aread()).decode("utf-8", "ignore")[:400]
                    raise RuntimeError(f"HTTP {resp.status_code} · {detail}")
                got = False
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    try:
                        evt = json.loads(line[5:])
                    except ValueError:
                        continue
                    chunk = (evt.get("data") or {}).get("audio", "")
                    if chunk:
                        got = True
                        yield bytes.fromhex(chunk)
                    br = evt.get("base_resp") or {}
                    code = br.get("status_code")
                    if code not in (0, None) and not got:
                        # voice id 不存在 / 余额 / 鉴权等：未出过音频就报错带出原因。
                        raise RuntimeError(f"MiniMax base_resp · {br}")
