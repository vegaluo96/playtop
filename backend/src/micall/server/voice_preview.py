"""角色音色试听 —— 用角色**真实** voice_id 合成一句问候 → WAV，供用户端/后台『试听』真实播放。

不是动画占位：走和通话同一条 TTS（同一 voice_id、同一供应商），听到的就是这个角色真实的声音。
TTS 未配置（endpoint/key 空）时返回空 WAV（前端静默忽略，不报错）。无新增三方依赖（WAV 头用 struct）。
"""
from __future__ import annotations

import asyncio
import logging
import struct

log = logging.getLogger("micall.voicepreview")

_RATE = 24000                       # 与 tts.sample_rate 一致（s16 mono）
_PREVIEW_TEXT = "你好呀，我是{name}。很高兴认识你，有什么想聊的随时找我。"
_MAX_BYTES = _RATE * 2 * 12         # 试听最多 ~12s，防极端长合成


def _wav(pcm: bytes, rate: int = _RATE) -> bytes:
    """裸 PCM(s16 mono) 套上 WAV 头 → 浏览器可直接 <audio> 播放。"""
    n = len(pcm)
    return (
        b"RIFF" + struct.pack("<I", 36 + n) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
        + b"data" + struct.pack("<I", n) + pcm
    )


async def _synth(text: str, voice_id: str) -> bytes:
    from contextlib import aclosing

    from ..config import load_config
    from ..providers import make_tts

    node = load_config().node("tts")
    tts = make_tts(node)
    buf = bytearray()
    # aclosing：达到 _MAX_BYTES 而 break（或异常）时也关掉生成器，释放底层 httpx 流/连接，不漏连接。
    async with aclosing(tts.synthesize(text, voice_id=voice_id, emotion="", sample_rate=_RATE)) as gen:
        async for chunk in gen:
            buf.extend(chunk)
            if len(buf) >= _MAX_BYTES:
                break
    return bytes(buf)


def _resolve(character_id: str, voice_id: str) -> tuple[str, str]:
    """取（角色名, voice_id）。优先用传入 voice_id（后台按音色试听）；否则取角色 spec 的 voice_id；
    都没有则回退全局默认音色。"""
    name, vid = "我", (voice_id or "").strip()
    cid = (character_id or "").strip()
    try:
        from ..config import load_config
        from .characters_admin import effective_specs

        specs = effective_specs()
        if cid and cid in specs:
            spec = specs[cid]
            name = (spec.get("identity", {}) or {}).get("name") or name
            if not vid:
                vid = ((spec.get("voice", {}) or {}).get("voice_id") or "").strip()
        if not vid:
            gd = load_config().global_defaults
            vid = str(gd.get("default_voice", "") or "").strip()
    except Exception as e:  # pragma: no cover
        log.warning("试听解析角色失败：%r", e)
    return name, vid


def preview_wav(character_id: str = "", voice_id: str = "") -> bytes:
    """合成该角色音色的一句问候 → WAV 字节。失败/未配置 TTS → 仅 WAV 头（空音频，前端忽略）。"""
    name, vid = _resolve(character_id, voice_id)
    text = _PREVIEW_TEXT.format(name=name)
    try:
        pcm = asyncio.run(_synth(text, vid))
    except Exception as e:  # pragma: no cover
        log.warning("试听合成失败：%r", e)
        pcm = b""
    return _wav(pcm)
