"""真·实时流式 ASR —— 阿里云百炼 DashScope WebSocket 原生协议（run-task / result-generated）。

与「整段录音识别」（bailian_asr.py，HTTP）不同：这条是边说边转，喂 PCM 帧、实时吐句子，
内置静音判句（max_sentence_silence）即天然的 end-of-turn（§1.4），sentence_end 直接当 is_final。
完美贴合 ASRProvider.stream(frames) → (text, is_final) 接口，可直接接编排 task A 感知。

协议（DashScope 原生，二进制音频不走 base64，更省）：
  ① 连 wss://.../api-ws/v1/inference/  头 Authorization: bearer <key>
  ② 发 run-task（task_group=audio/task=asr/function=recognition，model + parameters）
  ③ 收 task-started → 开始直接 ws.send(<raw pcm bytes>) 逐帧
  ④ 收 result-generated：payload.output.sentence.{text, sentence_end}
  ⑤ 帧发完发 finish-task → 收 task-finished
区端点（key 绑定区）：北京 wss://dashscope.aliyuncs.com/...；新加坡 wss://dashscope-intl.aliyuncs.com/...
（实测香港→新加坡区整段识别仅 675ms，故默认新加坡区。）

音频要求：单声道 PCM16，采样率与 run-task 的 sample_rate 一致（默认 16k）。需 websockets。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import AsyncIterator, Callable

from ..config import NodeConfig
from .base import ASRProvider

DEFAULT_WS_INTL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/"


def region_ws_base(http_endpoint: str) -> str:
    """从 ASR 的 HTTP endpoint 推断**区域通用** WS 主机（不是业务空间专属域名）。

    实测：实时 WS（api-ws）在通用区域端点 dashscope-intl 上鉴权通过；专属 MaaS 域名
    （ws-xxxx.ap-southeast-1.maas.aliyuncs.com）未必有 api-ws。故按区域取通用主机。
    """
    from urllib.parse import urlparse

    host = (urlparse(http_endpoint or "").netloc or "").lower()
    intl = (not host) or ("intl" in host) or ("ap-southeast" in host) or (".maas." in host)
    return "wss://dashscope-intl.aliyuncs.com" if intl else "wss://dashscope.aliyuncs.com"


class RealtimeBailianASR(ASRProvider):
    def __init__(self, node: NodeConfig, *, on_event: Callable[[dict], None] | None = None) -> None:
        if not node.api_key.strip():
            raise RuntimeError(f"节点 {node.name} 未配置 api_key（铁律2）")
        self.api_key = node.api_key
        # WS 端点：显式 ws_endpoint 优先；否则从 HTTP endpoint 主机推导（自动适配
        # 业务空间专属域名 ws-xxxx.ap-southeast-1.maas.aliyuncs.com，key 绑该主机）。
        self.ws_url = node.params.get("ws_endpoint") or self._derive_ws(node.endpoint)
        self.model = node.params.get("realtime_model", "paraformer-realtime-v2")
        self.sample_rate = int(node.params.get("sample_rate", 16000))
        self.audio_format = node.params.get("audio_format", "pcm")
        self.language_hints = node.params.get("language_hints", ["zh", "en"])
        self.max_sentence_silence = int(node.params.get("max_sentence_silence", 800))
        self._on_event = on_event  # 调试钩子：每个原始服务端事件回调一次（联调锁协议用）

    @staticmethod
    def _derive_ws(http_endpoint: str) -> str:
        return region_ws_base(http_endpoint) + "/api-ws/v1/inference/"

    def _run_task(self, task_id: str) -> str:
        return json.dumps({
            "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
            "payload": {
                "task_group": "audio", "task": "asr", "function": "recognition",
                "model": self.model,
                "parameters": {
                    "sample_rate": self.sample_rate,
                    "format": self.audio_format,
                    "language_hints": self.language_hints,
                    "max_sentence_silence": self.max_sentence_silence,
                    "punctuation_prediction_enabled": True,
                    "inverse_text_normalization_enabled": True,
                    "heartbeat": False,
                },
                "input": {},
            },
        })

    def _finish_task(self, task_id: str) -> str:
        return json.dumps({
            "header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"},
            "payload": {"input": {}},
        })

    async def stream(
        self, frames: AsyncIterator[bytes]
    ) -> AsyncIterator[tuple[str, bool]]:  # pragma: no cover （需真实网络/密钥）
        from websockets.asyncio.client import connect

        task_id = uuid.uuid4().hex
        started = asyncio.Event()

        async with connect(
            self.ws_url,
            additional_headers={"Authorization": f"bearer {self.api_key}"},
            max_size=None,
        ) as ws:
            await ws.send(self._run_task(task_id))

            async def _send() -> None:
                await started.wait()                # task-started 后才发音频
                async for f in frames:
                    if f:
                        await ws.send(f)            # 原始二进制 PCM 帧
                await ws.send(self._finish_task(task_id))

            sender = asyncio.create_task(_send())
            try:
                while True:
                    raw = await ws.recv()
                    evt = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
                    if self._on_event:
                        self._on_event(evt)
                    ev = (evt.get("header") or {}).get("event")
                    if ev == "task-started":
                        started.set()
                    elif ev == "result-generated":
                        s = ((evt.get("payload") or {}).get("output") or {}).get("sentence") or {}
                        txt = s.get("text") or ""
                        if txt:
                            yield txt, bool(s.get("sentence_end"))
                    elif ev == "task-finished":
                        break
                    elif ev == "task-failed":
                        msg = (evt.get("header") or {}).get("error_message") \
                            or (evt.get("payload") or {}).get("message") or evt
                        raise RuntimeError(f"ASR task-failed · {msg}")
            finally:
                started.set()                       # 防 sender 永远等待
                sender.cancel()
                try:
                    await sender
                except (asyncio.CancelledError, Exception):
                    pass
