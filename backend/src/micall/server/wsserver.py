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
from pathlib import Path
from typing import Any

from ..config import Config, load_config, resolve_voice
from ..context import CharacterRuntime, ContextAssembler
from ..memory import InMemoryRepository, MemoryRepository
from ..offline import UnderstandingEngine
from ..protocol import ServerEvent, parse_client_message
from ..providers import make_llm, make_tts
from ..session import CallSession

log = logging.getLogger("micall.signal")

_REPO_ROOT = Path(__file__).resolve().parents[4]
_CHARACTERS_DIR = _REPO_ROOT / "asset-pipeline" / "characters"
_DEFAULT_REMAINING = 720  # 骨架默认通话余额（秒）；真实从 users 表读 remaining_seconds（§5）
_ANON = "anon"            # 骨架无鉴权；真实从登录态取 user_id


def _load_characters() -> dict[str, CharacterRuntime]:
    """加载资产管线产出的出厂角色 spec（铁律7：出厂、全用户共享）。"""
    out: dict[str, CharacterRuntime] = {}
    if _CHARACTERS_DIR.is_dir():
        for p in sorted(_CHARACTERS_DIR.glob("*.json")):
            try:
                spec = json.loads(p.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            c = CharacterRuntime.from_spec(spec)
            if c.character_id:
                out[c.character_id] = c
    return out


class SignalingServer:
    def __init__(self, config: Config, repo: MemoryRepository | None = None) -> None:
        self.config = config
        self.repo = repo or InMemoryRepository()
        self.characters = _load_characters()
        # 离线理解引擎（§3.3）用慢脑（llm_slow，未配置则 stub）。会话结束后台触发，不碰实时路径。
        self.understanding = UnderstandingEngine(make_llm(config.node("llm_slow")), self.repo)
        self._bg_tasks: set[asyncio.Task] = set()

    def _schedule_understanding(self, session: "CallSession") -> None:
        """通话结束 → 后台跑离线理解（写事实层 + 修正画像 + 生成下次策略）。fire-and-forget。"""
        if not session or not session.history:
            return
        history = list(session.history)
        char = session.character_id

        async def run() -> None:
            try:
                await self.understanding.process_call(_ANON, char, history)
                log.info("离线理解完成 char=%s", char)
            except Exception as e:  # 离线失败不影响任何实时路径
                log.warning("离线理解失败：%r", e)

        task = asyncio.create_task(run())
        self._bg_tasks.add(task)               # 存引用防 GC
        task.add_done_callback(self._bg_tasks.discard)

    def _reload_config(self) -> None:
        """每通电话前重载配置：后台网页改了 endpoint/key，下一通即生效（不必重启服务）。"""
        try:
            self.config = load_config()
        except Exception as e:  # 配置文件临时损坏：沿用上一次可用配置
            log.warning("配置重载失败，沿用旧配置：%r", e)

    def _character(self, character_id: str | None) -> CharacterRuntime:
        if character_id and character_id in self.characters:
            return self.characters[character_id]
        if self.characters:  # 未知 id：退回第一个出厂角色
            return next(iter(self.characters.values()))
        # 资产目录为空时的兜底占位角色，保证骨架可独立运行。
        return CharacterRuntime(
            character_id=character_id or "stub",
            name="林晚",
            persona={"core_traits": ["温柔", "会倾听"], "speaking_style": "轻声、慢"},
        )

    def _make_session(self, *, emit, character_id, scenario) -> CallSession:
        char = self._character(character_id)
        user_voice = self.repo.get_user_voice(_ANON, char.character_id)
        voice_id = resolve_voice(
            self.config.global_defaults.get("default_voice", ""), char.voice_id, user_voice
        )
        profile = self.repo.get_profile(_ANON, char.character_id)
        assembler = ContextAssembler(
            char,
            profile=profile,
            autonomous=self.repo.get_autonomous(char.character_id),  # §4.1 TA 今天的状态
            memory=self.repo,
            memory_top_k=int(self.config.global_defaults.get("memory_depth", 5)),
        )
        return CallSession(
            config=self.config,
            emit=emit,
            llm=make_llm(self.config.node("llm_fast")),
            tts=make_tts(self.config.node("tts")),
            assembler=assembler,
            character_id=char.character_id,
            scenario=scenario or "",
            remaining_seconds=_DEFAULT_REMAINING,
            voice_id=voice_id,
        )

    async def handle(self, websocket: Any) -> None:
        session: CallSession | None = None

        async def emit(ev: dict) -> None:
            if ev.get("type") != "billing":  # billing 每秒一次，不刷屏
                log.info("  ⟶ %s", ev.get("type"))
            await websocket.send(json.dumps(ev, ensure_ascii=False))

        addr = getattr(websocket, "remote_address", None)
        log.info("⇆ 新连接 %s", addr[0] if addr else "?")
        try:
            async for raw in websocket:
                msg = parse_client_message(raw)
                if msg is None:
                    continue  # 畸形/未知帧静默丢弃（与前端容错一致）
                log.info("⟵ %s%s", msg.type, f" {msg.text!r}" if msg.text else "")
                if msg.type == "start_call":
                    if session:
                        await session.end(emit_ended=False)
                    self._reload_config()  # 拾取后台「接口配置」最新改动（无需重启）
                    session = self._make_session(
                        emit=emit, character_id=msg.character_id, scenario=msg.scenario
                    )
                    await session.start()
                elif msg.type == "switch_character":
                    if session:
                        await session.end(emit_ended=False)  # 切角色 = 结束 + 新建（docs/03 §3）
                    self._reload_config()
                    session = self._make_session(
                        emit=emit, character_id=msg.character_id, scenario=msg.scenario
                    )
                    await session.start()
                elif msg.type == "end_call":
                    if session:
                        await session.end()
                        self._schedule_understanding(session)
                        session = None
                elif msg.type == "text_input":
                    if session and msg.text:
                        await session.on_user_text(msg.text)
                elif msg.type == "mute":
                    if session:
                        session.set_muted(bool(msg.on))
                elif msg.type == "set_scene":
                    if session and msg.scene:
                        session.set_scene(msg.scene)
        except Exception:  # 连接异常：尽力清理会话
            pass
        finally:
            if session:
                await session.end(emit_ended=False)
                self._schedule_understanding(session)


async def serve_forever(config: Config) -> None:
    from websockets.asyncio.server import serve  # 延迟导入：仅运行服务才需 websockets

    server = SignalingServer(config)
    host = config.server.get("ws_host", "0.0.0.0")
    port = int(config.server.get("ws_port", 8787))
    path = config.server.get("path", "/realtime/signal")
    # 后台「接口配置」HTTP API（本地监听，nginx 反代 /admin/api-config）。
    admin_host = config.server.get("admin_host", "127.0.0.1")
    admin_port = int(config.server.get("admin_port", 8788))
    try:
        from .adminapi import run_admin_http

        run_admin_http(admin_host, admin_port)
        print(f"[micall] 后台配置 API http://{admin_host}:{admin_port}/admin/api-config")
    except Exception as e:  # 配置 API 起不来不影响通话主链路
        log.warning("后台配置 API 启动失败：%r", e)
    print(f"[micall] 信令服务器监听 ws://{host}:{port}{path}")
    async with serve(server.handle, host, port):
        await asyncio.Future()  # run forever
