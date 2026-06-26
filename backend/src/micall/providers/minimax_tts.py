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


def _is_param_error(e: Exception) -> bool:
    """像不像「参数不被接受」（2013 invalid params / 提到 emotion / invalid param）。只对这类做降级，
    避免把网络/鉴权/余额等错误误判成"参数不支持"。"""
    s = repr(e).lower()
    return ("2013" in s) or ("emotion" in s) or ("invalid" in s and "param" in s)


def _is_network_error(e: Exception) -> bool:
    """像不像「连接/网络层」错误（连接被掐、超时、读写失败、连接池超时）。这类要丢弃连接池重来，
    而不是当参数问题降级——是「没声音、重启才好」的元凶（长驻进程的 keep-alive 连接变质）。"""
    if httpx is not None and isinstance(e, (httpx.TransportError, httpx.TimeoutException)):
        return True
    s = repr(e).lower()
    return any(k in s for k in ("timeout", "connecterror", "connectionerror", "connecterror",
                                "remoteprotocol", "readerror", "writeerror", "pooltimeout"))


# 进程级：扩展功能（language_boost/pronunciation_dict/english_normalization/voice_modify）整体是否可用。
# 某次带扩展报参数错、去掉扩展就好 → 说明扩展格式与该端点不符，本进程不再带（省得每句都试错），并打日志。
_RICH_OK = True


_SHARED_CLIENT: "httpx.AsyncClient | None" = None


def _shared_client() -> "httpx.AsyncClient":
    """进程级共享 HTTP 连接池：跨通话/跨句复用 keep-alive，省掉「每句一次 TCP+TLS 握手」→ 首块更快。
    keepalive_expiry=20s：闲置超 20s 的连接主动丢弃。长驻进程在通话空档里，到 MiniMax 的 keep-alive
    连接常被对端/NAT 悄悄掐成半死（TCP 没复位），下一通复用就挂到超时=「没声音」。主动过期闲置连接，
    让下一通拿新连接，从源头少踩这个坑（配合 _reset_client 的失败兜底）。"""
    global _SHARED_CLIENT
    if _SHARED_CLIENT is None or _SHARED_CLIENT.is_closed:
        _SHARED_CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            limits=httpx.Limits(keepalive_expiry=20.0),
        )
    return _SHARED_CLIENT


async def _reset_client() -> None:
    """网络/连接类错误后丢弃共享连接池：变质的 keep-alive 连接会让后续每句都挂到超时=「没声音、只能重启」。
    重建池让下一次合成拿到全新连接，进程自愈、无需手动 restart（治本次反复发作的根）。"""
    global _SHARED_CLIENT
    c, _SHARED_CLIENT = _SHARED_CLIENT, None
    if c is not None and not c.is_closed:
        try:
            await c.aclose()
        except Exception:
            pass


class MiniMaxTTS(TTSProvider):
    def __init__(self, node: NodeConfig) -> None:
        if httpx is None:  # pragma: no cover
            raise RuntimeError("MiniMaxTTS 需要 httpx：pip install -r requirements.txt")
        if not node.configured:
            raise RuntimeError(f"节点 {node.name} 未配置 endpoint/api_key（铁律2）")
        self.node = node
        p = node.params
        self.model = p.get("model", "speech-2.8-turbo")
        # 榨干 2.8-turbo 的"质量/正确性"功能（都走配置，铁律2；不确定格式时由下方分级兜底保平安）：
        self._language_boost = str(p.get("language_boost", "auto") or "")   # 自动判语种，助中英混说；"" 则不传
        self._english_norm = bool(p.get("english_normalization", True))      # 数字/缩写读得自然
        pd = p.get("pronunciation_dict") or []                               # 纠正多音字/名字/英文：["处理/(chu3)(li3)", ...]
        self._pron_dict = [str(x) for x in pd] if isinstance(pd, list) else []
        vm = p.get("voice_modify") or {}                                     # 音色微调 {pitch,intensity,timbre,sound_effects}；默认空=不动
        self._voice_modify = dict(vm) if isinstance(vm, dict) else {}

    async def synthesize(
        self, text: str, *, voice_id: str, emotion: str = "",
        speed: float = 1.0, pitch: int = 0, vol: float = 1.0,
        sample_rate: int = 24000, audio_format: str = "pcm",
    ) -> AsyncIterator[bytes]:  # pragma: no cover （需真实网络/密钥）
        """句子级流式合成：stream=true，按 SSE 收 hex 音频块，首块一出即可下行（§1.7）。
        emotion/speed/pitch/vol 让 AI 说话带情绪。audio_format：通话下行用 "pcm"，试听用 "mp3"。
        分级自愈（绝不让通话因任何参数断话）：全功能 → 去扩展 → 去情绪。每档若「参数错且没出过音频」就降一档。"""
        global _RICH_OK
        vid = voice_id or self.node.params.get("default_voice", "")
        emo = _minimax_emotion(emotion) if vid not in _NO_EMOTION_VOICES else ""

        # 第一档：尽量全功能（情绪 + 扩展）。
        yielded = False
        try:
            async for chunk in self._stream(vid, text, emo, speed, pitch, vol, sample_rate, audio_format, rich=_RICH_OK):
                yielded = True
                yield chunk
            return
        except Exception as e:
            # 网络/连接错误（连接变质=「没声音」的根）：丢弃连接池 + 用新连接重试一次，进程自愈、免手动重启。
            if not yielded and _is_network_error(e):
                await _reset_client()
                log.warning("TTS 连接错误，已重置连接池并重试一次：%r", e)
                async for chunk in self._stream(vid, text, emo, speed, pitch, vol, sample_rate, audio_format, rich=_RICH_OK):
                    yielded = True
                    yield chunk
                return
            if yielded or not _is_param_error(e):
                raise  # 出过音频 / 非参数错（鉴权/余额）→ 照常抛，上层兜底
            log.warning("TTS 合成参数被拒，分级降级重试：%r", e)

        # 第二档：去掉扩展功能（保留情绪 + 韵律）——定位是不是扩展参数格式与端点不符。
        if _RICH_OK:
            yielded = False
            try:
                async for chunk in self._stream(vid, text, emo, speed, pitch, vol, sample_rate, audio_format, rich=False):
                    yielded = True
                    yield chunk
                _RICH_OK = False   # 去掉扩展就好了 → 扩展格式有问题，本进程不再带（日志已提示，可据此修配置）
                log.warning("扩展功能(language_boost/pronunciation_dict/english_normalization/voice_modify)疑似格式不符，本进程停用")
                return
            except Exception as e:
                if yielded or not _is_param_error(e):
                    raise

        # 第三档：连情绪也去掉（最小安全）→ 记下该音色不支持 emotion。
        if emo:
            _NO_EMOTION_VOICES.add(vid)
            log.warning("voice %s 疑似不支持 emotion，降级为仅韵律", vid)
        async for chunk in self._stream(vid, text, "", speed, pitch, vol, sample_rate, audio_format, rich=False):
            yield chunk

    async def _stream(
        self, vid: str, text: str, emo: str, speed: float, pitch: int, vol: float,
        sample_rate: int, audio_format: str, *, rich: bool = True,
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
        if rich and self._english_norm:
            vs["english_normalization"] = True
        body: dict = {
            "model": self.model,
            "text": text,
            "stream": True,
            "voice_setting": vs,
            "audio_setting": {"sample_rate": sample_rate, "format": audio_format, "channel": 1},
        }
        if rich:
            # 榨干 2.8-turbo：语种增强 / 发音纠正 / 音色微调。空则不传（不画蛇添足）。
            if self._language_boost:
                body["language_boost"] = self._language_boost
            if self._pron_dict:
                body["pronunciation_dict"] = {"tone": self._pron_dict}
            if self._voice_modify:
                body["voice_modify"] = self._voice_modify
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
