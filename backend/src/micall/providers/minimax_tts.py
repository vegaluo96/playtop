"""真实 TTS provider —— MiniMax T2A v2（官方直连，emotion + voice_id，docs/02 节点）。

endpoint/key 全配置（铁律2）。endpoint 形如 https://api.minimax.chat/v1/t2a_v2?GroupId=xxx
（GroupId 拼在 query 里）。骨架先用非流式（整段合成）验证音色；真实通话用流式句子级，
接入点同此类，把 stream 打开按 SSE 收 hex 音频块即可。需 httpx；未配置时工厂回退 StubTTS。
"""
from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from ..config import NodeConfig
from .base import TTSProvider

log = logging.getLogger("micall.tts")

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


# MiniMax T2A v2 voice_setting.emotion 只认这几种；传其它值会 2013 invalid params。
_MINIMAX_EMOTIONS = {"happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"}
_EMOTION_ALIAS = {
    "joyful": "happy", "excited": "happy", "pleased": "happy", "warm": "happy", "playful": "happy",
    "sympathy": "sad", "sorrow": "sad", "down": "sad", "comfort": "sad",
    "worried": "fearful", "anxious": "fearful", "nervous": "fearful",
}

# 进程级：实测不支持 emotion 参数的 voice_id（首次报 2013 即记下，后续直接只走韵律，不再带 emotion）。
# 目标：音色库里每个音色都能用——支持情绪的吃情绪，不支持的自动降级到 speed/pitch/拟声，绝不报错断话。
_NO_EMOTION_VOICES: set[str] = set()


def _minimax_emotion(tag: str) -> str:
    """内部情绪标签 → MiniMax 认的情绪；非枚举(tender/playful…)/未知 → 空（省略=默认，靠韵律实现）。"""
    t = (tag or "").strip().lower()
    if t in _MINIMAX_EMOTIONS:
        return t
    return _EMOTION_ALIAS.get(t, "")


def _is_param_emotion_error(e: Exception) -> bool:
    """这个错误像不像「该音色不支持 emotion 参数」（2013 invalid params / 提到 emotion）。
    只对这类做降级缓存，避免把网络/鉴权等瞬时错误误判成"音色不支持情绪"而永久砍掉它的情绪。"""
    s = repr(e).lower()
    return ("2013" in s) or ("emotion" in s) or ("invalid" in s and "param" in s)


_SHARED_CLIENT: "httpx.AsyncClient | None" = None


def _shared_client() -> "httpx.AsyncClient":
    """进程级共享 HTTP 连接池：跨通话/跨句复用 keep-alive，省掉「每句一次 TCP+TLS 握手」→ 首块更快。"""
    global _SHARED_CLIENT
    if _SHARED_CLIENT is None or _SHARED_CLIENT.is_closed:
        _SHARED_CLIENT = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0))
    return _SHARED_CLIENT


class MiniMaxTTS(TTSProvider):
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("MiniMaxTTS 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self.node = node
        self.model = node.params.get("model", "speech-2.8-turbo")

    async def synthesize(
        self, text: str, *, voice_id: str, emotion: str = "",
        speed: float = 1.0, pitch: int = 0, vol: float = 1.0,
        sample_rate: int = 24000, audio_format: str = "pcm",
    ) -> AsyncIterator[bytes]:  # pragma: no cover （需真实网络/密钥）
        """句子级流式合成：stream=true，按 SSE 收 hex 音频块，首块一出即可下行（§1.7）。
        emotion/speed/pitch/vol 让 AI 说话带情绪。audio_format：通话下行用 "pcm"，试听用 "mp3"。
        emotion 自愈：该音色不支持 emotion（2013）→ 记下并仅靠韵律重试一次，绝不让通话因情绪参数断话。"""
        vid = voice_id or self.node.params.get("default_voice", "")
        emo = _minimax_emotion(emotion) if vid not in _NO_EMOTION_VOICES else ""
        yielded = False
        try:
            async for chunk in self._stream(vid, text, emo, speed, pitch, vol, sample_rate, audio_format):
                yielded = True
                yield chunk
        except Exception as e:
            # 只在「带了 emotion + 还没出过音频 + 像情绪参数错」时降级重试；其它错照常抛（上层兜底）。
            if emo and not yielded and _is_param_emotion_error(e):
                _NO_EMOTION_VOICES.add(vid)
                log.warning("voice %s 不支持 emotion，降级为仅韵律重试：%r", vid, e)
                async for chunk in self._stream(vid, text, "", speed, pitch, vol, sample_rate, audio_format):
                    yield chunk
            else:
                raise

    async def _stream(
        self, vid: str, text: str, emo: str, speed: float, pitch: int, vol: float,
        sample_rate: int, audio_format: str,
    ) -> AsyncIterator[bytes]:  # pragma: no cover （需真实网络/密钥）
        # 钳到 MiniMax 合法区间：speed 0.5–2、pitch -12~12 整、vol 0–10。越界会 2013。
        vs: dict = {
            "voice_id": vid,
            "speed": max(0.5, min(2.0, float(speed))),
            "vol": max(0.0, min(10.0, float(vol))),
            "pitch": max(-12, min(12, int(round(pitch)))),
        }
        if emo:
            vs["emotion"] = emo  # 仅传 MiniMax 认的情绪，否则省略（默认中性）
        body: dict = {
            "model": self.model,
            "text": text,
            "stream": True,
            "voice_setting": vs,
            "audio_setting": {"sample_rate": sample_rate, "format": audio_format, "channel": 1},
        }
        headers = {
            "Authorization": f"Bearer {self.node.api_key}",
            "Content-Type": "application/json",
        }
        async with _shared_client().stream(
            "POST", self.node.endpoint, headers=headers, json=body
        ) as resp:
            if resp.status_code >= 400:
                detail = (await resp.aread()).decode("utf-8", "ignore")[:400]
                raise RuntimeError(f"HTTP {resp.status_code} · {detail}")
            got = False
            last_resp = None
            tail: list[str] = []
            async for line in resp.aiter_lines():
                if not line:
                    continue
                # 兼容非 SSE 的错误响应：data: 开头取负载，否则整行当 JSON 试。
                payload = line[5:] if line.startswith("data:") else line
                try:
                    evt = json.loads(payload)
                except ValueError:
                    tail.append(line[:200])
                    continue
                data = evt.get("data") or {}
                chunk = data.get("audio", "")
                # status==2 / 带 extra_info 是末尾汇总事件：会把整段音频再发一遍 →
                # 已有增量块就跳过，否则音频翻倍（合成的语音会重复念一遍）。
                is_summary = data.get("status") == 2 or "extra_info" in evt
                if chunk and not (is_summary and got):
                    got = True
                    yield bytes.fromhex(chunk)
                br = evt.get("base_resp")
                if br:
                    last_resp = br
                    code = br.get("status_code")
                    if code not in (0, None) and not got:
                        # voice id 不存在 / 余额 / 鉴权 / token not match group 等：报错带出原因。
                        raise RuntimeError(f"MiniMax base_resp · {br}")
            if not got:
                # 没出过音频也别静默：把能拿到的原因抛出来（国内/国际 GroupId-key 不配对最常见）。
                reason = last_resp or " ".join(tail)[:400] or (
                    "无音频且无错误体——检查 endpoint 是否国内 t2a_v2、GroupId 是否拼在 query、"
                    "国内域名要配国内账号的 key")
                raise RuntimeError(f"MiniMax 未返回音频 · {reason}")
