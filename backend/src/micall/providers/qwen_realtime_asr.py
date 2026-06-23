"""实时流式 ASR —— 阿里云百炼 qwen3-asr-flash-realtime（OpenAI-Realtime 风格 WS 协议）。

国际站（新加坡）的实时 ASR 用这个（paraformer-realtime-v2 在该区不可用，run-task 报
ModelNotFound）。与 realtime_asr.py 的 run-task 协议不同，这条走 OpenAI-Realtime 事件流：
  连 wss://<region>/api-ws/v1/realtime?model=qwen3-asr-flash-realtime  头 Authorization: bearer <key>
  ① session.update：input_audio_format=pcm16 + server_vad
  ② input_audio_buffer.append：base64(PCM16 16k 单声道) 逐块
  ③ server_vad 自动判句 → conversation.item.input_audio_transcription.{text/delta=中间, completed=最终}
产出 (text, is_final)，直接喂编排 task A。需 websockets。

字段名按 OpenAI-Realtime + 百炼文档实现；首跑用 scripts/asr_stream_once.py --debug 看原始
事件可一次校准（与 run-task 那次定位 ModelNotFound 同法）。
"""
from __future__ import annotations

import asyncio
import base64
import json
from typing import AsyncIterator, Callable

from ..config import NodeConfig
from .base import ASRProvider
from .bailian_asr import _collapse_repeat
from .realtime_asr import region_ws_base


class QwenRealtimeASR(ASRProvider):
    def __init__(self, node: NodeConfig, *, on_event: Callable[[dict], None] | None = None) -> None:
        if not node.api_key.strip():
            raise RuntimeError(f"节点 {node.name} 未配置 api_key（铁律2）")
        self.api_key = node.api_key
        self.ws_url = node.params.get("ws_endpoint") or (region_ws_base(node.endpoint) + "/api-ws/v1/realtime")
        self.model = node.params.get("realtime_model", "qwen3-asr-flash-realtime")
        self.sample_rate = int(node.params.get("sample_rate", 16000))
        # 端点检测（判定「你说完了」）。silence_ms 越小，说完后 AI 接话越快——治「说完卡很久 / 一直正在聆听」；
        # threshold 越高越能滤掉外放回授/环境噪声，减少把噪声听成词的幻觉（如开场冒出 tender）。可在 asr 节点 params 调。
        self.vad_threshold = float(node.params.get("vad_threshold", 0.55))
        self.vad_prefix_ms = int(node.params.get("vad_prefix_padding_ms", 250))
        self.vad_silence_ms = int(node.params.get("vad_silence_ms", 550))
        self._on_event = on_event

    async def stream(
        self, frames: AsyncIterator[bytes]
    ) -> AsyncIterator[tuple[str, bool]]:  # pragma: no cover （需真实网络/密钥）
        """断线自动重连续传：ASR WS 中途断了就退避重连（同一 frames，不丢后续语音），整通不会「突然不应答」；
        挂断时本 task 被 cancel → CancelledError 向上抛、不重连。"""
        import logging
        _log = logging.getLogger("micall.asr")
        backoff = 0.5
        while True:
            try:
                async for _out in self._stream_once(frames):
                    yield _out
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                _log.warning("ASR 流中断，%.1fs 后重连：%r", backoff, e)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 5.0)

    async def _stream_once(
        self, frames: AsyncIterator[bytes]
    ) -> AsyncIterator[tuple[str, bool]]:  # pragma: no cover
        from websockets.asyncio.client import connect

        url = f"{self.ws_url}?model={self.model}"
        ready = asyncio.Event()

        async with connect(
            url,
            additional_headers={"Authorization": f"bearer {self.api_key}"},
            max_size=None,
        ) as ws:
            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text"],
                    "input_audio_format": "pcm",   # DashScope 用 "pcm"+sample_rate（非 OpenAI 的 pcm16）
                    "sample_rate": self.sample_rate,
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": self.vad_threshold,
                        "prefix_padding_ms": self.vad_prefix_ms,
                        "silence_duration_ms": self.vad_silence_ms,
                    },
                },
            }))

            async def _send() -> None:
                await ready.wait()
                async for f in frames:
                    if f:
                        await ws.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(f).decode(),
                        }))
                # 帧流结束（挂断）：提交剩余缓冲，促使服务端给最终结果。
                try:
                    await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                except Exception:
                    pass

            sender = asyncio.create_task(_send())
            text = ""
            try:
                async for raw in ws:
                    evt = json.loads(raw) if isinstance(raw, (str, bytes, bytearray)) else raw
                    if self._on_event:
                        self._on_event(evt)
                    et = evt.get("type", "")
                    if et in ("session.created", "session.updated"):
                        ready.set()
                    elif "input_audio_transcription" in et:
                        if et.endswith(".completed"):
                            final = _collapse_repeat(evt.get("transcript") or text)
                            text = ""
                            if final:
                                yield final, True
                        else:
                            # 中间结果：百炼把累计文本放在 stash（text 常为空）。
                            seg = evt.get("stash") or evt.get("text") or evt.get("delta") or ""
                            if seg:
                                # stash 累计 → 以已得为前缀则替换，否则拼接。
                                text = seg if seg.startswith(text) else text + seg
                                yield text, False
                    elif et == "error":
                        raise RuntimeError(f"qwen-realtime error · {evt.get('error') or evt}")
            finally:
                ready.set()
                sender.cancel()
                try:
                    await sender
                except (asyncio.CancelledError, Exception):
                    pass
