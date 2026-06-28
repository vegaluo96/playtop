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
import logging
from typing import AsyncIterator, Callable

from ..config import NodeConfig, as_float, as_int
from .base import ASRProvider
from .bailian_asr import _collapse_repeat
from .realtime_asr import region_ws_base

log = logging.getLogger("micall.asr.qwen_realtime")


def _extract_emotion(evt: dict) -> str:
    """从实时转写事件里尽力抽出【声音情绪】标签（百炼可能放在 annotations[].emotion、顶层 emotion 等处，
    且各版本字段名有别）→ 防御式多处探测。抽不到返回空，绝不让解析失败拖垮 ASR 流。纯函数，便于测试。"""
    if not isinstance(evt, dict):
        return ""
    e = evt.get("emotion")
    if isinstance(e, str) and e.strip():
        return e.strip()
    for key in ("annotations", "annotation"):
        anns = evt.get(key)
        if isinstance(anns, list):
            for a in anns:
                if isinstance(a, dict):
                    em = a.get("emotion") or (a.get("value") if a.get("type") == "emotion" else "")
                    if isinstance(em, str) and em.strip():
                        return em.strip()
        elif isinstance(anns, dict):
            em = anns.get("emotion")
            if isinstance(em, str) and em.strip():
                return em.strip()
    return ""


class QwenRealtimeASR(ASRProvider):
    def __init__(self, node: NodeConfig, *, on_event: Callable[[dict], None] | None = None) -> None:
        if not node.api_key.strip():
            raise RuntimeError(f"节点 {node.name} 未配置 api_key（铁律2）")
        self.api_key = node.api_key
        self.ws_url = node.params.get("ws_endpoint") or (region_ws_base(node.endpoint) + "/api-ws/v1/realtime")
        self.model = node.params.get("realtime_model", "qwen3-asr-flash-realtime")
        self.sample_rate = as_int(node.params.get("sample_rate"), 16000)   # 坏配置不崩，回退默认
        # 端点检测（判定「你说完了」）。silence_ms 越小，说完后 AI 接话越快——治「说完卡很久 / 一直正在聆听」；
        # threshold 越高越能滤外放回授/噪声，但太高会识别不到说话→「一直聆听卡住」。0.55 是验证可用的稳定值：
        # 灵敏度↔可靠是同一道阈值的两端，不宜盲调；要更稳的抗噪用耳机/半双工（物理）。可在 asr 节点 params 微调。
        self.vad_threshold = as_float(node.params.get("vad_threshold"), 0.55)
        self.vad_prefix_ms = as_int(node.params.get("vad_prefix_padding_ms"), 250)
        self.vad_silence_ms = as_int(node.params.get("vad_silence_ms"), 550)
        self._on_event = on_event
        # 「免费升级」：实时 ASR 在转写之外还会给这句话的【声音情绪】。每条 final 更新，编排层读它喂角色。
        # 空=本句 neutral/未识别/该版本不产出（静默降级，对通话零影响）。
        self.last_emotion = ""

    async def stream(
        self, frames: AsyncIterator[bytes]
    ) -> AsyncIterator[tuple[str, bool]]:  # pragma: no cover （需真实网络/密钥）
        """单次连接流式识别（连接断开即结束本通 ASR）。
        注：曾加过「断线自动重连」，但重连期间麦克风音频在队列积压、重连后服务端 server_vad 从头重判，
        会把同一段语音跨连接重复识别（用户实测「说一句被当成五遍」+ 延迟飙高），已回退为单次连接。
        若确需 mid-call 容灾，必须配合「重连后清空服务端 buffer + 跨连接精确去重」再开，否则弊大于利。"""
        async for out in self._stream_once(frames):
            yield out

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
                    if isinstance(raw, (str, bytes, bytearray)):
                        try:
                            evt = json.loads(raw)
                        except (ValueError, TypeError):
                            continue   # 非 JSON 帧（心跳/畸形）跳过，别让整条 ASR 流崩掉
                    else:
                        evt = raw
                    if not isinstance(evt, dict):
                        continue
                    if self._on_event:
                        self._on_event(evt)
                    et = evt.get("type", "")
                    if et in ("session.created", "session.updated"):
                        ready.set()
                    elif "input_audio_transcription" in et:
                        if et.endswith(".completed"):
                            emo = _extract_emotion(evt)   # 顺带取这句的声音情绪（有就更新，供编排层喂角色）
                            if emo:
                                self.last_emotion = emo
                                log.info("🎙️ 从声音听出语气情绪：%s", emo)
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
