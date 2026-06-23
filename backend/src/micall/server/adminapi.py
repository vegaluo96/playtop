"""后台「接口配置」HTTP API —— 运营在网页上配 endpoint/key/模型，存服务端（铁律2）。

前端 admin/src/logic/configService.ts 已约定契约：
  GET  /admin/api-config         → 各节点配置（key 打码返回）
  PUT  /admin/api-config         → 保存（key 含 • 视为未改、保留原值）
  POST /admin/api-config/test    → 实测某节点连通（LLM/TTS 真发一次请求）

存到 config/admin_overrides.json（gitignored，后端节点形态）。load_config 以最高优先级
合并它，即「网页配的 > micall.env 环境变量 > default.json」。改完下一通电话即生效
（SignalingServer 每通电话重载配置）。

零三方依赖：stdlib http.server 起一个本地 HTTP 线程，由 nginx 反代 /admin/api-config。
访问控制：默认仅监听 127.0.0.1，外网经 nginx（Basic Auth）反代；可选 MICALL_ADMIN_TOKEN
要求 Bearer 鉴权做纵深防御。
"""
from __future__ import annotations

import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ..config import NodeConfig, _REPO_DEFAULT, _header_safe, load_config

OVERRIDES_PATH = _REPO_DEFAULT.parent / "admin_overrides.json"

_REPO = None  # run_admin_http 注入（与 WS/用户 API 同一仓储实例）；用于看板真实数据

# admin 分区 → (后端节点, {admin 字段: 后端字段})
SECTION_TO_NODE: dict[str, tuple[str, dict[str, str]]] = {
    "asr":    ("asr",       {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "lang": "language"}),
    "fast":   ("llm_fast",  {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "temp": "temperature", "maxTokens": "reply_max_tokens"}),
    "tts":    ("tts",       {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "voiceId": "default_voice", "sampleRate": "sample_rate"}),
    "memory": ("llm_slow",  {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "maxContext": "max_context"}),
    "embed":  ("embedding", {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "vectorDB": "vector_db", "topK": "top_k"}),
}
_NUMERIC = {"temperature": float, "reply_max_tokens": int, "sample_rate": int, "top_k": int, "max_context": int}


def _mask(key: str) -> str:
    key = (key or "").strip()
    if not key:
        return ""
    return "••••••" + key[-4:] if len(key) > 4 else "••••••"


def _is_mask(v: str) -> bool:
    return "•" in (v or "")


def _coerce(bfield: str, sval: str):
    if bfield in _NUMERIC:
        m = re.search(r"-?\d+(?:\.\d+)?", sval.replace(",", ""))
        if m:
            try:
                return _NUMERIC[bfield](m.group())
            except ValueError:
                pass
    return sval


# ── GET：当前生效配置 → admin 形态（key 打码）──
def read_config_for_admin() -> dict:
    cfg = load_config()
    out: dict[str, dict[str, str]] = {}
    for section, (node_key, fields) in SECTION_TO_NODE.items():
        node = cfg.node(node_key)
        sec: dict[str, str] = {}
        for afield, bfield in fields.items():
            if bfield == "api_key":
                sec[afield] = _mask(node.api_key)
            elif bfield == "endpoint":
                sec[afield] = node.endpoint
            elif bfield == "provider":
                sec[afield] = node.provider
            else:
                v = node.params.get(bfield, "")
                sec[afield] = "" if v is None else str(v)
        out[section] = sec
    return out


# ── PUT：admin 形态 → 写 admin_overrides.json（后端形态，仅写非空/已改字段）──
def write_config_from_admin(payload: dict) -> None:
    existing: dict = {}
    if OVERRIDES_PATH.exists():
        try:
            existing = json.loads(OVERRIDES_PATH.read_text("utf-8"))
        except (ValueError, OSError):
            existing = {}
    nodes = existing.setdefault("nodes", {})
    for section, sec in (payload or {}).items():
        mapping = SECTION_TO_NODE.get(section)
        if not mapping or not isinstance(sec, dict):
            continue
        node_key, fields = mapping
        node = nodes.setdefault(node_key, {})
        for afield, bfield in fields.items():
            if afield not in sec:
                continue
            val = "" if sec[afield] is None else str(sec[afield])
            if bfield == "api_key":
                if _is_mask(val) or not val.strip():
                    continue                       # 未改：保留原值
                node["api_key"] = _header_safe(val)   # 清洗粘贴带进的 U+2028/零宽/换行等头非法字符
            elif bfield == "endpoint":
                sval = _header_safe(val)
                if not sval:
                    continue
                node["endpoint"] = sval
            else:
                sval = val.strip()
                if not sval:
                    continue                       # 空：不写，沿用 env/default
                node[bfield] = _coerce(bfield, sval)
    tmp = OVERRIDES_PATH.with_name(OVERRIDES_PATH.name + ".tmp")
    tmp.write_text(json.dumps(existing, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(OVERRIDES_PATH)


# ── POST /test：真发一次请求验连通（正是 1004/2049 那类问题的照妖镜）──
async def _ping_llm(node: NodeConfig) -> dict:
    import time

    from ..providers import make_llm

    llm = make_llm(node)
    t0 = time.perf_counter()
    async for _tok in llm.stream([{"role": "user", "content": "你好"}], max_tokens=1):
        break
    return {"ok": True, "ms": int((time.perf_counter() - t0) * 1000)}


async def _ping_tts(node: NodeConfig) -> dict:
    import time

    from ..providers import make_tts

    tts = make_tts(node)
    voice = node.params.get("default_voice", "")
    t0 = time.perf_counter()
    async for _chunk in tts.synthesize("你好", voice_id=voice, emotion=""):
        break
    return {"ok": True, "ms": int((time.perf_counter() - t0) * 1000)}


async def _ping_embed(node: NodeConfig) -> dict:
    import time

    from ..providers import make_embedding

    emb = make_embedding(node)
    if emb is None:
        return {"ok": False, "error": "该 provider 暂不支持向量化（试 bailian_embedding）"}
    t0 = time.perf_counter()
    vec = await emb.embed_one("你好")
    if not vec:
        return {"ok": False, "error": "未返回向量，检查 endpoint/model（应为 .../compatible-mode/v1/embeddings）"}
    return {"ok": True, "ms": int((time.perf_counter() - t0) * 1000), "note": f"维度 {len(vec)}"}


def test_section(section: str, sec: dict) -> dict:
    import asyncio

    mapping = SECTION_TO_NODE.get(section)
    if not mapping:
        return {"ok": False, "error": f"未知节点 {section!r}"}
    node_key, fields = mapping
    eff = load_config().node(node_key)
    endpoint = (sec.get("endpoint") or eff.endpoint or "").strip()
    key = sec.get("key") or ""
    if _is_mask(key) or not key.strip():
        key = eff.api_key                          # 打码/未填 → 用已存真实 key
    params = dict(eff.params)
    for afield, bfield in fields.items():
        if afield in sec and bfield not in ("endpoint", "api_key", "provider") and str(sec[afield]).strip():
            params[bfield] = _coerce(bfield, str(sec[afield]).strip())
    node = NodeConfig(
        name=node_key, provider=(sec.get("provider") or eff.provider or ""),
        endpoint=endpoint, api_key=key, params=params,
    )
    if not (endpoint and key.strip()):
        return {"ok": False, "error": "endpoint / key 未填全"}
    try:
        if node_key in ("llm_fast", "llm_slow"):
            return asyncio.run(_ping_llm(node))
        if node_key == "tts":
            return asyncio.run(_ping_tts(node))
        if node_key == "embedding":
            return asyncio.run(_ping_embed(node))
        return {"ok": True, "note": "已填 endpoint/key（ASR 未做真实连通）"}
    except Exception as e:  # 鉴权/网络/模型名等，原样回带便于排错
        return {"ok": False, "error": str(e)[:300]}


def login(payload: dict) -> tuple[int, dict]:
    """后台登录：校验账号密码，成功发 token（前端后续带 Authorization 访问配置 API）。

    账号取 MICALL_ADMIN_USER（默认 admin）。密码取 MICALL_ADMIN_PASSWORD：
      • 已设 → 必须匹配；
      • 未设 → 放行（真正门禁靠 nginx Basic Auth，此登录仅 UX 层）。
    token 取 MICALL_ADMIN_TOKEN（设了则配置 API 也校验它，形成完整应用级鉴权），否则 "dev"。
    返回 "dev" 是关键：前端识别到 "dev" 就**不发 Authorization: Bearer**，从而不顶掉浏览器
    自动携带的 Basic Auth 凭据（否则 nginx 收到 Bearer 而非 Basic → 401 → 反复弹密码框）。
    要用应用级 Bearer 鉴权时设 MICALL_ADMIN_TOKEN，并在 nginx 的 /admin/ 关掉 auth_basic 以免冲突。
    """
    user = os.environ.get("MICALL_ADMIN_USER", "admin").strip()
    pw = os.environ.get("MICALL_ADMIN_PASSWORD", "")
    token = os.environ.get("MICALL_ADMIN_TOKEN", "").strip() or "dev"
    u = str((payload or {}).get("username", "")).strip()
    p = str((payload or {}).get("password", ""))
    if u != user or (pw and p != pw):
        return 401, {"ok": False, "error": "账号或密码错误"}
    return 200, {"ok": True, "token": token}


def _authorized(headers) -> bool:
    want = os.environ.get("MICALL_ADMIN_TOKEN", "").strip()
    if not want:
        return True                                # 未设 → 依赖 nginx Basic Auth + 本地监听
    got = (headers.get("Authorization", "") or "").removeprefix("Bearer ").strip()
    return got == want


class _Handler(BaseHTTPRequestHandler):
    server_version = "MiCallAdmin/1.0"

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError):
            return {}

    def _route(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if not _authorized(self.headers):
            return self._json(401, {"error": "unauthorized"})
        if self._route() == "/admin/api-config":
            return self._json(200, read_config_for_admin())
        if self._route() == "/admin/characters":
            from .characters_admin import read_characters_for_admin
            return self._json(200, {"characters": read_characters_for_admin()})
        # ── 看板真实数据（P4）：未注入仓储则返回空，前端退回演示数据 ──
        if self._route() == "/admin/stats":
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            return self._json(200, {"ok": True, "stats": _REPO.admin_stats(),
                                    "top_characters": _REPO.top_characters(limit=5)})
        if self._route() == "/admin/users":
            if _REPO is None:
                return self._json(200, {"ok": False, "users": []})
            return self._json(200, {"ok": True, "users": _REPO.list_all_users(limit=200)})
        if self._route() == "/admin/calls":
            if _REPO is None:
                return self._json(200, {"ok": False, "calls": []})
            return self._json(200, {"ok": True, "calls": _REPO.list_all_calls(limit=200)})
        if self._route() == "/admin/orders":
            if _REPO is None:
                return self._json(200, {"ok": False, "orders": []})
            return self._json(200, {"ok": True, "orders": _REPO.list_all_orders(limit=200)})
        if self._route() == "/admin/redeem-codes":
            if _REPO is None:
                return self._json(200, {"ok": False, "codes": []})
            return self._json(200, {"ok": True, "codes": _REPO.list_redeem_codes(limit=200)})
        if self._route() == "/admin/tickets":
            if _REPO is None:
                return self._json(200, {"ok": False, "tickets": []})
            return self._json(200, {"ok": True, "tickets": _REPO.list_all_tickets(limit=200)})
        self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:
        if not _authorized(self.headers):
            return self._json(401, {"error": "unauthorized"})
        if self._route() == "/admin/api-config":
            try:
                write_config_from_admin(self._body())
                return self._json(200, {"ok": True})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)[:200]})
        if self._route() == "/admin/characters":
            try:
                from .characters_admin import write_character_from_admin
                write_character_from_admin(self._body())
                return self._json(200, {"ok": True})
            except Exception as e:
                return self._json(400, {"ok": False, "error": str(e)[:200]})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        route = self._route()
        if route == "/admin/login":                 # 登录本身不需 token（它负责发 token）
            code, obj = login(self._body())
            return self._json(code, obj)
        if not _authorized(self.headers):
            return self._json(401, {"error": "unauthorized"})
        if route == "/admin/api-config/test":
            b = self._body()
            return self._json(200, test_section(b.get("section", ""), b.get("config", {}) or {}))
        if route == "/admin/redeem-codes":      # 批量生成兑换码
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            b = self._body()
            count = max(1, min(500, int(b.get("count", 1) or 1)))      # 单次上限 500
            minutes = max(1, int(b.get("minutes", 60) or 60))
            codes = _REPO.create_redeem_codes(count, minutes * 60)
            return self._json(200, {"ok": True, "codes": codes})
        if route == "/admin/tickets/reply":     # 回复工单
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            b = self._body()
            ok = _REPO.reply_ticket(b.get("id"), (b.get("reply") or "").strip())
            return self._json(200, {"ok": ok})
        self._json(404, {"error": "not found"})

    def log_message(self, *args) -> None:  # 静默（journalctl 不刷屏）
        pass


def run_admin_http(host: str = "127.0.0.1", port: int = 8788, repo=None) -> ThreadingHTTPServer:
    global _REPO
    _REPO = repo  # 看板数据用；为 None 时数据路由返回空，前端退回演示
    httpd = ThreadingHTTPServer((host, port), _Handler)
    threading.Thread(target=httpd.serve_forever, name="micall-admin-http", daemon=True).start()
    return httpd
