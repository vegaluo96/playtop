"""服务端 WebRTC 媒体传输（可选 / 实验）—— 真·全双工的成熟路径。

默认通话走 WS + PCM（半双工，稳：AI 外放时不上行）。前端带 ?rtc=1 时改走这条：浏览器用
RTCPeerConnection 把麦克风 Opus 上行、把 AI 语音 Opus 下行；浏览器据此进入"通信模式"，
移动端外放也能开启硬件级回声消除(AEC) → 麦克风全程开也不回授，可边说边随时打断（豆包式）。

需要 aiortc（见 requirements.txt，可从 wheel 直装，无需 apt）。未装则 available()=False，
该路径不可用，但绝不影响默认 WS 通话。信令复用现有 WS：
    前端 → 服务端：{type:"rtc_offer", sdp} / {type:"rtc_ice", candidate, sdpMid, sdpMLineIndex}
    服务端 → 前端：{type:"rtc_answer", sdp}
音频转码（PyAV）：上行 48k Opus→解码→重采样 16k 喂 ASR；下行 TTS 24k PCM→重采样 48k→Opus 下行。
ICE：服务端非 trickle（answer SDP 内已含候选）；客户端候选用 addIceCandidate 补入。
"""
from __future__ import annotations

import asyncio
import logging
import json
import os
import time
from fractions import Fraction
from typing import Awaitable, Callable

log = logging.getLogger("micall.webrtc")

try:  # 延迟/可选导入：未装 aiortc 也能 import 本模块
    import av  # PyAV：编解码 + 重采样
    from aiortc import (
        RTCConfiguration,
        RTCIceCandidate,
        RTCIceServer,
        RTCPeerConnection,
        RTCSessionDescription,
    )
    from aiortc.mediastreams import MediaStreamTrack
    from aiortc.sdp import candidate_from_sdp
    _OK = True
except Exception as _e:  # pragma: no cover
    _OK = False
    _IMPORT_ERR = _e


def available() -> bool:
    """aiortc/av 是否就绪（决定 ?rtc=1 能否启用）。"""
    return _OK


TTS_RATE = 24000      # 编排下行 TTS PCM 采样率（config tts.sample_rate）
RTC_RATE = 48000      # WebRTC/Opus 标准采样率
ASR_RATE = 16000      # ASR 上行采样率
FRAME_SAMPLES = RTC_RATE * 20 // 1000   # 20ms @48k = 960 样本/帧

# 服务端 ICE：从 MICALL_ICE_SERVERS（JSON）读，**默认空**（只收 host 候选 = 公网 IP 直连，开场瞬间完成）。
# 切忌配境内连不通的 STUN（如 Google）——aiortc 的 setLocalDescription 会阻塞等 ICE 收集，连不通的 STUN
# 会拖到超时(~5s)才发 answer = "一上来很慢"。架了 coturn 后把它填进来（境内可达），才用得上 TURN 中继。
#   例：MICALL_ICE_SERVERS='[{"urls":"turn:zsky.com:3478","username":"micall","credential":"<pw>"}]'
def _ice_servers_from_env() -> list:
    raw = os.environ.get("MICALL_ICE_SERVERS", "").strip()
    if not raw:
        return []
    out: list = []
    try:
        for s in json.loads(raw):
            urls = s.get("urls")
            if not urls:
                continue
            kw = {"urls": urls}
            if s.get("username"):
                kw["username"] = s["username"]
            if s.get("credential"):
                kw["credential"] = s["credential"]
            out.append(RTCIceServer(**kw))   # 仅 _OK 时（__init__ 内）调用，RTCIceServer 必在
    except Exception as e:
        log.warning("MICALL_ICE_SERVERS 解析失败，退回 host 直连：%r", e)
    return out


if _OK:

    class _TTSTrack(MediaStreamTrack):
        """下行 AI 语音轨：外部 feed 24k PCM（s16 mono），内部重采样到 48k，按 20ms 实时节奏吐帧。"""

        kind = "audio"

        def __init__(self) -> None:
            super().__init__()
            self._buf = bytearray()      # 48k s16 mono PCM 待发缓冲
            self._resampler = av.AudioResampler(format="s16", layout="mono", rate=RTC_RATE)
            self._ts = 0                 # 已发样本数（pts）
            self._start: float | None = None
            self._in_pts = 0             # 输入帧 pts 计数（喂给重采样器）
            self._closed = False
            self._flush_until = 0.0      # 打断后短暂拒收在途残留块的截止时刻

        def feed(self, pcm24: bytes) -> None:
            """喂入编排产生的 24k PCM（s16 mono）；重采样到 48k 累积到发送缓冲。"""
            if self._closed or not pcm24:
                return
            if time.time() < self._flush_until:
                return  # 打断后极短窗口内的在途残留块：丢弃，别 re-fill 刚清空的缓冲（打断更干脆）
            n = len(pcm24) // 2
            if n <= 0:
                return
            frame = av.AudioFrame(format="s16", layout="mono", samples=n)
            frame.sample_rate = TTS_RATE
            frame.time_base = Fraction(1, TTS_RATE)
            frame.pts = self._in_pts
            self._in_pts += n
            frame.planes[0].update(pcm24[: n * 2])
            for out in self._resampler.resample(frame):
                self._buf.extend(bytes(out.planes[0])[: out.samples * 2])

        def flush(self) -> None:
            """打断/挂断：丢掉未发的 AI 语音，并在极短窗口内拒收在途残留块（防被打断那句的尾巴 re-fill）。"""
            self._buf.clear()
            self._flush_until = time.time() + 0.12

        async def recv(self):  # aiortc 按需拉帧；这里按 20ms 实时节奏返回
            if self._start is None:
                self._start = time.time()
            self._ts += FRAME_SAMPLES
            delay = (self._start + self._ts / RTC_RATE) - time.time()
            if delay > 0:
                await asyncio.sleep(delay)
            need = FRAME_SAMPLES * 2
            chunk = bytes(self._buf[:need])
            del self._buf[: len(chunk)]
            if len(chunk) < need:
                chunk += b"\x00" * (need - len(chunk))   # 无数据补静音，保持轨道存活
            frame = av.AudioFrame(format="s16", layout="mono", samples=FRAME_SAMPLES)
            frame.planes[0].update(chunk)
            frame.sample_rate = RTC_RATE
            frame.pts = self._ts
            frame.time_base = Fraction(1, RTC_RATE)
            return frame

        def stop(self) -> None:  # type: ignore[override]
            self._closed = True
            try:
                super().stop()
            except Exception:
                pass


class RTCVoiceTransport:
    """一通电话的 WebRTC 媒体面。emit：把 rtc_answer 等控制帧异步发给前端；on_audio：上行 16k PCM
    回调（→ CallSession.push_audio）。下行用 feed_tts(24k PCM)；打断用 flush_tts()。"""

    def __init__(self, emit: Callable[[dict], Awaitable[None]], on_audio: Callable[[bytes], None],
                 on_connected: "Callable[[bool], None] | None" = None) -> None:
        if not _OK:  # pragma: no cover
            raise RuntimeError(f"aiortc 未安装，WebRTC 不可用：{_IMPORT_ERR!r}")
        self._emit = emit
        self._on_audio = on_audio
        self._on_connected = on_connected   # 真连上/断开回调（→ 标记全双工硬件 AEC，放开服务端回声判定）
        self.connected = False              # RTC 是否真连上：连上前下行先走 WS（开场不等 RTC ~2s 协商），连上后切 RTC 轨
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=_ice_servers_from_env()))
        self.tts = _TTSTrack()
        self.pc.addTrack(self.tts)
        self._consumers: set[asyncio.Task] = set()

        @self.pc.on("track")
        def _on_track(track):  # 上行麦克风 Opus 轨
            if track.kind == "audio":
                t = asyncio.ensure_future(self._consume(track))
                self._consumers.add(t)
                t.add_done_callback(self._consumers.discard)

        @self.pc.on("connectionstatechange")
        async def _on_state():
            st = self.pc.connectionState
            log.info("WebRTC 连接状态 → %s", st)
            # 真连上=全双工硬件 AEC 生效 + 下行切到 RTC 轨；failed/closed=退回 WS。
            # disconnected 可能瞬断后自愈，不翻转 connected（留给后续状态）。
            if st == "connected":
                self.connected = True
            elif st in ("failed", "closed"):
                self.connected = False
            if self._on_connected is not None:
                if st == "connected":
                    self._on_connected(True)
                elif st in ("failed", "closed"):
                    self._on_connected(False)

    async def _consume(self, track) -> None:
        """读上行音轨 → 重采样到 16k → 回调喂 ASR。"""
        resampler = av.AudioResampler(format="s16", layout="mono", rate=ASR_RATE)
        try:
            while True:
                frame = await track.recv()
                for out in resampler.resample(frame):
                    pcm = bytes(out.planes[0])[: out.samples * 2]
                    if pcm:
                        self._on_audio(pcm)
        except Exception as e:  # 轨道结束/连接断开
            log.info("上行音轨结束：%r", e)

    async def handle_offer(self, sdp: str) -> None:
        """收前端 offer → 设远端 → 生成 answer（含本端 ICE 候选，非 trickle）→ 回 rtc_answer。"""
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)   # aiortc 在此等 ICE 收集完成
        await self._emit({"type": "rtc_answer", "sdp": self.pc.localDescription.sdp})

    async def add_ice(self, payload: dict) -> None:
        """补入前端 trickle 候选。"""
        cand_str = (payload or {}).get("candidate") or ""
        if not cand_str:
            return
        try:
            cand = candidate_from_sdp(cand_str.split(":", 1)[1] if cand_str.startswith("candidate:") else cand_str)
            cand.sdpMid = payload.get("sdpMid")
            cand.sdpMLineIndex = payload.get("sdpMLineIndex")
            await self.pc.addIceCandidate(cand)
        except Exception as e:
            log.warning("addIceCandidate 失败：%r", e)

    def feed_tts(self, pcm24: bytes) -> None:
        self.tts.feed(pcm24)

    def flush_tts(self) -> None:
        self.tts.flush()

    async def close(self) -> None:
        for t in list(self._consumers):
            t.cancel()
        try:
            self.tts.stop()
        except Exception:
            pass
        try:
            await self.pc.close()
        except Exception:
            pass
