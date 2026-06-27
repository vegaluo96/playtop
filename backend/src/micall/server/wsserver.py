"""WebSocket 信令服务器 —— 把会话编排接到前端（docs/03 控制通道）。

每个 WS 连接 = 一通电话。入站 ClientMessage 驱动 CallSession，出站 ServerEvent 下发。
前端把 VITE_SIGNALING_URL 指向 ws://host:port/path 即从 Mock 切到真实后端（铁律2，端点可配）。

注意：音频媒体走独立 WebRTC 通道（本服务只管控制信令）。真实部署在编排里接 Pipecat/
LiveKit 的媒体管线（task A 喂帧 / task C 下行），骨架用 stub 驱动同一套状态机与信令。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

from ..config import Config, load_config, resolve_voice
from ..context import CharacterRuntime, ContextAssembler
from ..memory import MemoryRepository, make_repository
from ..offline import AutonomyEngine, UnderstandingEngine, due_to_advance
from ..protocol import ServerEvent, parse_client_message
from ..providers import make_embedding, make_llm, make_realtime_asr, make_tts
from ..session import CallSession

log = logging.getLogger("micall.signal")

_REPO_ROOT = Path(__file__).resolve().parents[4]
_CHARACTERS_DIR = _REPO_ROOT / "asset-pipeline" / "characters"
_GUEST_TRIAL_SECONDS = 60  # 游客（未登录）试用：1 分钟，到期提示注册（注册即送 60 分钟）
# 单连接入站【文本/控制帧】限流（音频二进制帧不计——其按 20ms/帧本就高频）。滑窗超限即丢弃，
# 防恶意客户端刷 text_input / 畸形帧耗 CPU。50/10s 对正常使用（打字、ICE 协商）很宽裕。
_WS_CTRL_LIMIT = 50
_WS_CTRL_WINDOW = 10.0
_ANON = "anon"            # 骨架无鉴权；真实从登录态取 user_id
_AUTONOMY_THROTTLE_S = 3 * 3600  # 角色自主状态最多每 3 小时推进一次（节流慢脑成本 + 近况不过快变）


def _client_ip(websocket: Any) -> str:
    """客户端真实 IP：优先 nginx 转发的 X-Forwarded-For / X-Real-IP，回退握手对端地址。游客防刷按它计配额。"""
    try:
        headers = getattr(getattr(websocket, "request", None), "headers", None)
        if headers:
            xff = headers.get("X-Forwarded-For") or headers.get("x-forwarded-for")
            if xff:
                return xff.split(",")[0].strip()
            xri = headers.get("X-Real-IP") or headers.get("x-real-ip")
            if xri:
                return xri.strip()
    except Exception:
        pass
    addr = getattr(websocket, "remote_address", None)
    return addr[0] if addr else "unknown"


def _resolve_user(repo: MemoryRepository, websocket: Any) -> str:
    """从 WS 握手 URL 的 ?token= 解析登录用户。无/失效 → 游客 _ANON（仍可通话，前端会提示注册）。"""
    try:
        from urllib.parse import parse_qs, urlsplit

        path = getattr(getattr(websocket, "request", None), "path", "") or ""
        token = parse_qs(urlsplit(path).query).get("token", [""])[0]
        if token:
            uid = repo.user_for_token(token)
            if uid:
                return uid
    except Exception as e:
        log.warning("token 解析失败，按游客处理：%r", e)
    return _ANON


def _load_characters() -> dict[str, CharacterRuntime]:
    """加载出厂角色 spec + 后台「角色管理」覆盖（铁律7：出厂、全用户共享）。
    effective_specs 合并 character_overrides.json，运营在后台改完下一通即生效。"""
    from .characters_admin import effective_specs

    out: dict[str, CharacterRuntime] = {}
    for spec in effective_specs().values():
        c = CharacterRuntime.from_spec(spec)
        if c.character_id:
            out[c.character_id] = c
    return out


class SignalingServer:
    def __init__(self, config: Config, repo: MemoryRepository | None = None) -> None:
        self.config = config
        self.repo = repo or make_repository(config)   # 配了 database.dsn → Postgres 持久化，否则内存
        self.characters = _load_characters()
        # 出厂角色写入存储（facts/profile 的 FK 前置）；内存实现为 no-op。
        try:
            from .characters_admin import effective_specs
            self.repo.seed_characters(effective_specs())
        except Exception as e:
            log.warning("角色 seed 失败：%r", e)
        # 离线理解引擎（§3.3）每次会话结束按当前配置新建（慢脑 llm_slow + 向量化 embedding），
        # 这样 admin 改了「接口配置」即时生效；后台触发，不碰实时路径。
        self._bg_tasks: set[asyncio.Task] = set()
        self._autonomy_last: dict[str, float] = {}  # char_id → 上次推进自主状态的 monotonic（节流，见 _schedule_autonomy）

    def _consume_balance(self, user_id: str, session: "CallSession") -> None:
        """登录用户挂断 → 按实际通话秒数扣余额 + 记 call 流水（§5 服务端权威计费）。游客不入账。"""
        if user_id == _ANON or not session:
            return
        consumed = int(getattr(getattr(session, "billing", None), "elapsed", 0) or 0)
        if consumed > 0:
            try:
                self.repo.add_seconds(user_id, -consumed, "call")
            except Exception as e:
                log.warning("扣费失败 user=%s：%r", user_id, e)

    def _record_call(self, user_id: str, session: "CallSession") -> None:
        """登录用户挂断 → 落一条通话记录（前端「通话历史」数据源）。游客不记。"""
        if user_id == _ANON or not session:
            return
        meter = getattr(session, "billing", None)
        dur = int(getattr(meter, "elapsed", 0) or 0)
        if dur <= 0:
            return
        reason = "out_of_minutes" if getattr(meter, "exhausted", False) else "ended"
        try:
            self.repo.add_call(user_id, session.character_id, getattr(session, "scenario", ""), dur, reason)
        except Exception as e:
            log.warning("通话记录失败 user=%s：%r", user_id, e)

    def _record_usage(self, user_id: str, session: "CallSession") -> None:
        """挂断 → 按整通实际用量写 usage_log（成本看板数据源）。游客也记（成本与计费无关）。"""
        try:
            for node, units, micros in session.cost_breakdown():
                self.repo.add_usage(user_id, node, units, micros)
        except Exception as e:
            log.warning("用量记录失败：%r", e)

    def _on_call_end(self, user_id: str, session: "CallSession", client_ip: str = "") -> None:
        """通话收尾统一入口：扣费 + 记通话 + 记用量成本 + 触发离线理解。三处结束点共用。"""
        if user_id == _ANON:
            consumed = int(getattr(getattr(session, "billing", None), "elapsed", 0) or 0)
            if consumed > 0:   # 游客：按 IP 累计试用消耗，刷新/重连不再白送（防刷）
                try:
                    self.repo.consume_guest_trial(client_ip, consumed)
                except Exception as e:
                    log.warning("游客试用扣减失败：%r", e)
        else:
            self._consume_balance(user_id, session)
            self._record_call(user_id, session)
        self._record_usage(user_id, session)
        self._schedule_understanding(session, user_id)
        self._schedule_autonomy(session)

    def _schedule_autonomy(self, session: "CallSession") -> None:
        """通话结束 → 后台推进「角色自己这段时间的近况」（§4.2，per-character，独立于用户）。fire-and-forget。
        这是「她有对话之外的生命」的来源：下次通话时 get_autonomous 读到的 mood/近况/精力即由此生长。
        节流（_AUTONOMY_THROTTLE_S）：同一角色最多每隔一段才推一次——既省较贵的慢脑，也让近况自然推进、
        不至于每通都变一个人。游客通话也推（她的生活不分谁来电），成本由节流兜住。"""
        if not session:
            return
        char = session.character_id
        now = time.monotonic()
        last = self._autonomy_last.get(char)
        if not due_to_advance(last, now, _AUTONOMY_THROTTLE_S):
            return
        self._autonomy_last[char] = now
        # 距上次推进多久 → 近况粒度（首次用一天，给她攒点可主动提的事）。
        hours = 24.0 if last is None else max(1.0, (now - last) / 3600.0)
        try:
            character = self._character(char)
        except Exception as e:
            log.warning("自主状态推进取角色失败 char=%s：%r", char, e)
            return
        engine = AutonomyEngine(make_llm(self.config.node("llm_slow")), self.repo)

        async def run() -> None:
            try:
                await engine.advance(character, hours_since_last_call=hours)
                log.info("自主状态推进完成 char=%s", char)
            except Exception as e:  # 离线失败不影响任何实时路径
                log.warning("自主状态推进失败 char=%s：%r", char, e)

        task = asyncio.create_task(run())
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    def _schedule_understanding(self, session: "CallSession", user_id: str = _ANON) -> None:
        """通话结束 → 后台跑离线理解（写事实层 + 修正画像 + 生成下次策略）。fire-and-forget。
        两类通话不跑，省较贵的慢脑(Qwen-Long)+向量化、也不往画像写噪声：
          ① 游客(_ANON)：没有持久画像，跑了只会污染共享匿名记忆；
          ② 过短/无实质（误触秒挂、就一两句寒暄）：没信息量可提取。"""
        if not session or not session.history:
            return
        if user_id == _ANON:
            return
        history = list(session.history)
        has_user = any(m.get("role") == "user" for m in history)
        has_ai = any(m.get("role") == "assistant" for m in history)
        if not (has_user and has_ai) or sum(len(str(m.get("content", ""))) for m in history) < 24:
            log.info("通话过短/无实质内容，跳过离线理解（省慢脑成本）")
            return
        char = session.character_id
        # 当前配置新建：慢脑（apiyi/Qwen-Long，未配则 stub）+ 向量化（Embedding，未配则 None 退关键词）。
        engine = UnderstandingEngine(
            make_llm(self.config.node("llm_slow")),
            self.repo,
            embedder=make_embedding(self.config.node("embedding")),
        )

        async def run() -> None:
            try:
                await engine.process_call(user_id, char, history)
                log.info("离线理解完成 char=%s user=%s", char, user_id)
            except Exception as e:  # 离线失败不影响任何实时路径
                log.warning("离线理解失败：%r", e)

        task = asyncio.create_task(run())
        self._bg_tasks.add(task)               # 存引用防 GC
        task.add_done_callback(self._bg_tasks.discard)

    def _reload_config(self) -> None:
        """每通电话前重载配置 + 角色：后台网页改了 endpoint/key 或角色人设，下一通即生效（不必重启）。"""
        try:
            self.config = load_config()
        except Exception as e:  # 配置文件临时损坏：沿用上一次可用配置
            log.warning("配置重载失败，沿用旧配置：%r", e)
        try:
            self.characters = _load_characters()  # 拾取后台「角色管理」最新改动
        except Exception as e:
            log.warning("角色重载失败，沿用旧角色：%r", e)

    def _character(self, character_id: str | None) -> CharacterRuntime:
        if character_id and character_id in self.characters:
            return self.characters[character_id]
        if self.characters:  # 未知 id：退回第一个出厂角色
            return next(iter(self.characters.values()))
        # 资产目录为空时的兜底占位角色，保证骨架可独立运行。
        return CharacterRuntime(
            character_id=character_id or "stub",
            name="小语",
            persona={"core_traits": ["温柔", "会倾听"], "speaking_style": "轻声、慢"},
        )

    def _make_realtime_asr(self):
        """实时流式 ASR（task A）。需 api_key + ws_endpoint；缺则 None → 退文字模式。"""
        node = self.config.node("asr")
        if not (node.api_key.strip() and (node.endpoint.strip() or node.params.get("ws_endpoint"))):
            return None
        try:
            return make_realtime_asr(node)
        except Exception as e:  # 依赖缺失/构造失败：不阻断通话，退文字模式
            log.warning("实时 ASR 初始化失败，转文字模式：%r", e)
            return None

    def _make_session(self, *, emit, audio_emit=None, character_id, scenario, scenario_prompt="", user_id=_ANON, client_ip="") -> CallSession:
        char = self._character(character_id)
        # 人设指纹：把这通电话「实际载入」的角色字段打出来——后台改完打一通、grep 📇 即可确认
        # 编辑是否真喂进通话（不再靠猜「改了没生效」是数据没到、还是没重启、还是字段没接）。
        _id, _ps = (char.identity or {}), (char.persona or {})
        log.info(
            "📇 通话载入角色 id=%s name=%r 简介=%r 风格=%r 来历=%r 音色=%s",
            char.character_id, char.name,
            str(_id.get("tagline", ""))[:24], str(_ps.get("speaking_style", ""))[:24],
            str(_ps.get("background_story", ""))[:24], char.voice_id,
        )
        user_voice = self.repo.get_user_voice(user_id, char.character_id)
        voice_id = resolve_voice(
            self.config.global_defaults.get("default_voice", ""), char.voice_id, user_voice
        )
        profile = self.repo.get_profile(user_id, char.character_id)
        from .characters_admin import effective_autonomous
        assembler = ContextAssembler(
            char,
            profile=profile,
            autonomous=effective_autonomous(self.repo, char.character_id),  # §4.1 TA 今天的状态（无 DB 状态时用出厂初始近况）
            memory=self.repo,
            memory_top_k=int(self.config.global_defaults.get("memory_depth", 5)),
        )
        # 余额：登录用户读 users.remaining_seconds（服务端权威，§5）；游客按 IP 给剩余试用（刷新不重置，防刷）。
        remaining = (self.repo.remaining_seconds(user_id) if user_id != _ANON
                     else self.repo.guest_trial_remaining(client_ip, _GUEST_TRIAL_SECONDS))
        return CallSession(
            config=self.config,
            emit=emit,
            audio_emit=audio_emit,
            llm=make_llm(self.config.node("llm_fast")),
            tts=make_tts(self.config.node("tts")),
            realtime_asr=self._make_realtime_asr(),
            embedder=make_embedding(self.config.node("embedding")),
            assembler=assembler,
            character_id=char.character_id,
            scenario=scenario or "",
            scenario_prompt=scenario_prompt or "",
            remaining_seconds=remaining,
            voice_id=voice_id,
        )

    async def handle(self, websocket: Any) -> None:
        from . import webrtc

        session: CallSession | None = None
        rtc = None   # 可选 WebRTC 媒体面（?rtc=1 才建）；None 时音频走默认 WS+PCM

        async def emit(ev: dict) -> None:
            if ev.get("type") != "billing":  # billing 每秒一次，不刷屏
                log.info("  ⟶ %s", ev.get("type"))
            if rtc is not None and ev.get("type") in ("interrupted", "ended"):
                rtc.flush_tts()   # 打断/挂断：立刻丢掉 WebRTC 轨里未发的 AI 语音
            await websocket.send(json.dumps(ev, ensure_ascii=False))

        async def audio_emit(buf: bytes) -> None:
            if rtc is not None and rtc.connected:
                rtc.feed_tts(buf)          # RTC 已真连上 → 喂 TTS 轨（内部重采样 24k→48k + Opus）
            else:
                # 未连上（含 RTC 协商中的 ~2s）→ 走 WS：开场音频立即出声，不卡在 RTC 连接上。
                # 前端在 pc 未 connected 时本就播 WS 音频；RTC 一连上，前端切远端轨、后端这里也切 feed_tts。
                await websocket.send(buf)

        # 握手鉴权：优先靠连接后首条 auth 帧（见下方拦截）；URL ?token= 作向后兼容兜底（旧客户端）。
        # 无/失效 token → 游客 _ANON（仍可通话，前端会提示注册）。
        user_id = _resolve_user(self.repo, websocket)
        client_ip = _client_ip(websocket)   # 游客按 IP 计试用配额（防刷）
        log.info("⇆ 新连接 %s user=%s", client_ip, user_id)
        ctrl_hits: list[float] = []   # 入站控制帧时间戳滑窗（按连接，音频帧不计）
        ctrl_warned = False
        try:
            async for raw in websocket:
                if isinstance(raw, (bytes, bytearray)):
                    if session is not None:
                        session.push_audio(bytes(raw))  # 上行麦克风帧 → task A
                    continue
                # 文本/控制帧限流：滑窗超限即丢弃（防 text_input/畸形帧刷爆 CPU）。音频帧已在上面放行。
                now = time.time()
                ctrl_hits = [t for t in ctrl_hits if now - t < _WS_CTRL_WINDOW]
                if len(ctrl_hits) >= _WS_CTRL_LIMIT:
                    if not ctrl_warned:
                        log.warning("⚠ 连接 %s 控制帧超频(>%d/%.0fs)，开始丢弃", client_ip, _WS_CTRL_LIMIT, _WS_CTRL_WINDOW)
                        ctrl_warned = True
                    continue
                ctrl_warned = False
                ctrl_hits.append(now)
                # 先拦 WebRTC 信令（可选 ?rtc=1）：这些 type 不在 ClientMessage 里，单独处理。
                try:
                    d = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                # 首条鉴权帧：token 改由连接后首条消息携带（不再进 URL query → 不落 nginx/代理日志）。
                # 向后兼容：握手时已按 ?token= 解析过（_resolve_user），旧客户端仍可用；新客户端发本帧覆盖。
                if isinstance(d, dict) and d.get("type") == "auth":
                    tok = str(d.get("token") or "").strip()
                    if tok:
                        uid = self.repo.user_for_token(tok)
                        if uid:
                            user_id = uid
                            log.info("⇆ WS 首条鉴权 user=%s", user_id)
                    continue
                # 传输就绪：前端 loading 结束（RTC 真连上 或 已回退 WS）→ 此刻才让 AI 主动开口（开场白走在
                # 已就绪传输上：不切通道、AEC 已热、loading 已盖住建连）。begin_conversation 幂等，重复/已结束安全。
                if isinstance(d, dict) and d.get("type") == "ready":
                    if session is not None:
                        session.begin_conversation()
                    continue
                if isinstance(d, dict) and d.get("type") in ("rtc_offer", "rtc_ice", "rtc_close"):
                    if d.get("type") == "rtc_close":          # 前端回退 WS → 关掉 RTC，下行音频改回 WS
                        if rtc is not None:
                            await rtc.close()
                            rtc = None
                        if session is not None:
                            session.set_full_duplex(False)   # 退回 WS：恢复严格回声判定（无硬件 AEC）
                        continue
                    if not webrtc.available():
                        await emit({"type": "rtc_unavailable"})   # 后端没装 aiortc → 前端回退 WS
                        continue
                    if d["type"] == "rtc_offer":
                        if rtc is None:
                            rtc = webrtc.RTCVoiceTransport(
                                emit=emit,
                                on_audio=lambda pcm: session.push_audio(pcm) if session else None,
                                # 真连上(connected)才放开回声判定/降打断门槛；连不上回退 WS 时自动复位（见 _on_state）。
                                on_connected=lambda ok: session.set_full_duplex(ok) if session else None,
                            )
                        await rtc.handle_offer(d.get("sdp", ""))
                    elif rtc is not None:   # rtc_ice
                        await rtc.add_ice(d)
                    continue
                msg = parse_client_message(d)
                if msg is None:
                    continue  # 畸形/未知帧静默丢弃（与前端容错一致）
                log.info("⟵ %s%s", msg.type, f" {msg.text!r}" if msg.text else "")
                if msg.type == "start_call":
                    if user_id != _ANON and self.repo.is_banned(user_id):
                        await emit(ServerEvent.call_failed("banned"))   # 封禁用户（即便持旧 token）：拒接
                        continue
                    if session:
                        await session.end(emit_ended=False)
                    self._reload_config()  # 拾取后台「接口配置」最新改动（无需重启）
                    try:
                        session = self._make_session(
                            emit=emit, audio_emit=audio_emit,
                            character_id=msg.character_id, scenario=msg.scenario,
                            scenario_prompt=msg.scenario_prompt or "", user_id=user_id, client_ip=client_ip,
                        )
                        await session.start()
                    except Exception as e:  # 建会话失败（配置/provider 异常）不能让连接半死：发 call_failed 让前端可重试
                        log.warning("建立通话失败：%r", e)
                        session = None
                        await emit(ServerEvent.call_failed("server_error"))
                elif msg.type == "switch_character":
                    if session:
                        await session.end(emit_ended=False)  # 切角色 = 结束 + 新建（docs/03 §3）
                        self._on_call_end(user_id, session, client_ip)
                    self._reload_config()
                    try:
                        session = self._make_session(
                            emit=emit, audio_emit=audio_emit,
                            character_id=msg.character_id, scenario=msg.scenario,
                            scenario_prompt=msg.scenario_prompt or "", user_id=user_id, client_ip=client_ip,
                        )
                        await session.start()
                    except Exception as e:
                        log.warning("切换角色建会话失败：%r", e)
                        session = None
                        await emit(ServerEvent.call_failed("server_error"))
                elif msg.type == "end_call":
                    if session:
                        await session.end()
                        self._on_call_end(user_id, session, client_ip)
                        session = None
                    if rtc is not None:   # 挂断同时关掉 RTC 媒体面，否则僵尸 transport 泄漏到下一通：
                        await rtc.close()  # 第二通的 rtc_offer 会落到已断的旧 transport → 异常断连 → 计时卡 00:00
                        rtc = None
                elif msg.type == "text_input":
                    if session and msg.text:
                        await session.on_user_text(msg.text)
                elif msg.type == "mute":
                    if session:
                        session.set_muted(bool(msg.on))
                elif msg.type == "set_scene":
                    if session and msg.scene:
                        session.set_scene(msg.scene)
                elif msg.type == "reset_memory":
                    # 前端「重置记忆」：清该角色的事实层+理解层（持久记忆），并清当前通话滑窗。
                    char = msg.character_id or (session.character_id if session else None)
                    if char:
                        char = self._character(char).character_id  # 归一到出厂 id
                        self.repo.reset_memory(user_id, char)
                        if session and session.character_id == char:
                            session.history.clear()
                        log.info("🧹 重置记忆 char=%s", char)
        except Exception:  # 连接异常：尽力清理会话
            pass
        finally:
            if rtc is not None:
                await rtc.close()
            if session:
                await session.end(emit_ended=False)
                self._on_call_end(user_id, session, client_ip)


async def serve_forever(config: Config) -> None:
    from websockets.asyncio.server import serve  # 延迟导入：仅运行服务才需 websockets

    repo = make_repository(config)               # 仓储建一次，WS 与用户 HTTP API 共用（账号即时可见）
    server = SignalingServer(config, repo=repo)
    host = config.server.get("ws_host", "0.0.0.0")
    port = int(config.server.get("ws_port", 8787))
    path = config.server.get("path", "/realtime/signal")
    # 后台「接口配置」HTTP API（本地监听，nginx 反代 /admin/api-config）。
    admin_host = config.server.get("admin_host", "127.0.0.1")
    admin_port = int(config.server.get("admin_port", 8788))
    try:
        from .adminapi import run_admin_http

        run_admin_http(admin_host, admin_port, repo=repo)   # repo 供看板真实数据（/admin/stats|users|calls|orders）
        print(f"[micall] 后台配置 API http://{admin_host}:{admin_port}/admin/api-config")
    except Exception as e:  # 配置 API 起不来不影响通话主链路
        log.warning("后台配置 API 启动失败：%r", e)
    # C 端用户账号 API（注册/登录，本地监听，nginx 反代 /api/）。
    user_port = int(config.server.get("user_port", 8789))
    try:
        from .userapi import run_user_http

        run_user_http(repo, admin_host, user_port)
        print(f"[micall] 用户账号 API http://{admin_host}:{user_port}/api/auth/*")
    except Exception as e:  # 账号 API 起不来不影响通话主链路（游客仍可用）
        log.warning("用户账号 API 启动失败：%r", e)
    print(f"[micall] 信令服务器监听 ws://{host}:{port}{path}")
    # 心跳保活：默认 ping_interval=20s / ping_timeout=20s——大陆→香港的移动网一抖（>20s 没回 pong）就被判死、
    # 整通电话被掐（用户反馈「打着打着就连接失败」）。把 pong 超时放宽到 40s，能扛住绝大多数瞬时网络抖动而不掉线；
    # 仍每 20s 主动 ping（顺带保活 NAT/反代），真死连接最多 ~60s 内回收（finally 里随即停计费、不空跑）。
    async with serve(server.handle, host, port, ping_interval=20, ping_timeout=40):
        await asyncio.Future()  # run forever
