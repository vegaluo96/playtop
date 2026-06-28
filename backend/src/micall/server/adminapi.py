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

import hmac
import json
import logging
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ..config import NodeConfig, _REPO_DEFAULT, _header_safe, load_config

log = logging.getLogger("micall.admin")

OVERRIDES_PATH = _REPO_DEFAULT.parent / "admin_overrides.json"

_REPO = None  # run_admin_http 注入（与 WS/用户 API 同一仓储实例）；用于看板真实数据

# admin 分区 → (后端节点, {admin 字段: 后端字段})
SECTION_TO_NODE: dict[str, tuple[str, dict[str, str]]] = {
    "asr":    ("asr",       {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "lang": "language"}),
    "fast":   ("llm_fast",  {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "temp": "temperature", "maxTokens": "reply_max_tokens"}),
    "tts":    ("tts",       {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "voiceId": "default_voice", "sampleRate": "sample_rate"}),
    "memory": ("llm_slow",  {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "maxContext": "max_context"}),
    "embed":  ("embedding", {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "vectorDB": "vector_db", "topK": "top_k"}),
    "image":  ("image",     {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "size": "size"}),
    "eval":   ("llm_eval",  {"endpoint": "endpoint", "key": "api_key", "provider": "provider", "model": "model", "temp": "temperature", "maxTokens": "reply_max_tokens"}),
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
        if node_key in ("llm_fast", "llm_slow", "llm_eval"):
            return asyncio.run(_ping_llm(node))
        if node_key == "tts":
            return asyncio.run(_ping_tts(node))
        if node_key == "embedding":
            return asyncio.run(_ping_embed(node))
        return {"ok": True, "note": "已填 endpoint/key（ASR 未做真实连通）"}
    except Exception as e:  # 鉴权/网络/模型名等：回带便于排错，但抹掉可能回显的 key，完整详情仅记服务端日志
        msg = str(e)[:300]
        if key and key.strip():
            msg = msg.replace(key.strip(), "•••")
        log.warning("连通性测试失败 section=%s node=%s：%s", section, node_key, str(e)[:500])
        return {"ok": False, "error": msg}


# ── 计费单价（成本估算）读写：存 admin_overrides.json 的 cost 段，改完下一通即生效 ──
def read_cost_for_admin() -> dict:
    c = load_config().cost or {}
    tok = c.get("usd_per_1k_tokens", {}) or {}
    return {
        "chars_per_token": c.get("chars_per_token", 2),
        "llm_fast": tok.get("llm_fast", 0),
        "llm_slow": tok.get("llm_slow", 0),
        "embedding": tok.get("embedding", 0),
        "tts": c.get("usd_per_1k_chars_tts", 0),
        "asr": c.get("usd_per_minute_asr", 0),
    }


def write_cost_from_admin(payload: dict) -> None:
    def num(v, d):
        # 单价钳到 [0,10]：挡住负数/NaN/1e9 这类离谱值撑坏成本估算（实际单价都远小于 1）。
        try:
            x = float(v)
        except (TypeError, ValueError):
            return d
        if x != x:   # NaN
            return d
        return max(0.0, min(10.0, x))
    existing: dict = {}
    if OVERRIDES_PATH.exists():
        try:
            existing = json.loads(OVERRIDES_PATH.read_text("utf-8"))
        except (ValueError, OSError):
            existing = {}
    p = payload or {}
    existing["cost"] = {
        "chars_per_token": num(p.get("chars_per_token"), 2) or 2,
        "usd_per_1k_tokens": {
            "llm_fast": num(p.get("llm_fast"), 0),
            "llm_slow": num(p.get("llm_slow"), 0),
            "embedding": num(p.get("embedding"), 0),
        },
        "usd_per_1k_chars_tts": num(p.get("tts"), 0),
        "usd_per_minute_asr": num(p.get("asr"), 0),
    }
    tmp = OVERRIDES_PATH.with_name(OVERRIDES_PATH.name + ".tmp")
    tmp.write_text(json.dumps(existing, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(OVERRIDES_PATH)


# ── 邀请奖励（后台「邀请裂变」）读写：存 admin_overrides.json 的 invite 段，改完即对新注册生效 ──
def read_invite_for_admin() -> dict:
    return {"reward_minutes": int(load_config().raw.get("invite", {}).get("reward_minutes", 60) or 60)}


def write_invite_from_admin(payload: dict) -> None:
    existing: dict = {}
    if OVERRIDES_PATH.exists():
        try:
            existing = json.loads(OVERRIDES_PATH.read_text("utf-8"))
        except (ValueError, OSError):
            existing = {}
    try:
        m = max(0, min(10080, int((payload or {}).get("reward_minutes", 60) or 60)))   # 钳到 [0, 1 周]
    except (TypeError, ValueError):
        m = 60
    existing["invite"] = {"reward_minutes": m}
    tmp = OVERRIDES_PATH.with_name(OVERRIDES_PATH.name + ".tmp")
    tmp.write_text(json.dumps(existing, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(OVERRIDES_PATH)


# 弱口令/占位 token：视为「未配置」，一律按未配置 fail closed 处理。
_WEAK_SECRETS = {"dev", "test", "demo", "changeme", "change-me", "admin", "password",
                 "micall", "micall-admin", "token", "secret", "default"}
_MIN_TOKEN_LEN = 16     # 应用级 Bearer token：要求足够长的随机串
_MIN_PASSWORD_LEN = 8   # 后台登录密码：至少 8 位


def _admin_token() -> str:
    """安全配置的 Bearer token；未配置/弱口令/过短 → 空串（调用方据此 fail closed）。"""
    t = os.environ.get("MICALL_ADMIN_TOKEN", "").strip()
    if not t or t.lower() in _WEAK_SECRETS or len(t) < _MIN_TOKEN_LEN:
        return ""
    return t


def _admin_password() -> str:
    """安全配置的后台密码；未配置/弱口令/过短 → 空串（登录 fail closed）。"""
    p = os.environ.get("MICALL_ADMIN_PASSWORD", "")
    if not p or p.strip().lower() in _WEAK_SECRETS or len(p) < _MIN_PASSWORD_LEN:
        return ""
    return p


def login(payload: dict) -> tuple[int, dict]:
    """后台登录：校验账号密码，成功发 token（前端后续带 Authorization: Bearer 访问管理 API）。

    Fail closed（铁律：线上不得裸奔）：
      • MICALL_ADMIN_PASSWORD 或 MICALL_ADMIN_TOKEN 未安全配置（缺失/弱口令/过短）→ 503，绝不发 token。
      • 账号或密码不匹配 → 401。
    安全配置后，login 返回真实 token，前端带 Bearer；nginx 的 /admin/ 关掉 auth_basic 让 Bearer 透传，
    后端 _authorized 校验 Bearer 即应用级门禁（不再依赖「未设 token 就放行」的危险默认）。
    """
    user = os.environ.get("MICALL_ADMIN_USER", "admin").strip() or "admin"
    pw = _admin_password()
    token = _admin_token()
    if not pw or not token:
        return 503, {"ok": False, "error": "后台未安全配置：请设置强 MICALL_ADMIN_PASSWORD 与长随机 MICALL_ADMIN_TOKEN"}
    u = str((payload or {}).get("username", "")).strip()
    p = str((payload or {}).get("password", ""))
    if not hmac.compare_digest(u, user) or not hmac.compare_digest(p, pw):
        return 401, {"ok": False, "error": "账号或密码错误"}
    return 200, {"ok": True, "token": token}


def _authorized(headers) -> bool:
    """Fail closed：token 未安全配置 → 一律拒绝；否则要求 Bearer 与之常数时间相等。"""
    want = _admin_token()
    if not want:
        return False                               # 未安全配置 → 拒绝（不再裸奔放行）
    got = (headers.get("Authorization", "") or "").removeprefix("Bearer ").strip()
    return bool(got) and hmac.compare_digest(got, want)


def _allowed_origins() -> set:
    """CORS 白名单：仅 admin 域；本地开发经 MICALL_ADMIN_ALLOWED_ORIGINS 显式追加（逗号分隔）。"""
    out = {"https://admin.zsky.com"}
    for o in os.environ.get("MICALL_ADMIN_ALLOWED_ORIGINS", "").split(","):
        o = o.strip()
        if o:
            out.add(o)
    return out


class _Handler(BaseHTTPRequestHandler):
    server_version = "MiCallAdmin/1.0"

    def _cors(self) -> None:
        # 仅对白名单 Origin 反射并允许携带凭据；未知 Origin 不回 ACAO/ACAC（浏览器据此拦截跨域）。
        origin = (self.headers.get("Origin", "") or "").strip()
        if origin and origin in _allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Vary", "Origin")
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

    _MAX_BODY = 256 * 1024   # 请求体上限 256KB：管理 JSON 都很小，挡无上限请求体

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > self._MAX_BODY:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError):
            return {}

    def _route(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/")

    def _query(self, key: str) -> str:
        from urllib.parse import parse_qs, urlparse
        return (parse_qs(urlparse(self.path).query).get(key, [""])[0] or "").strip()

    def _audio_wav(self, data: bytes) -> None:
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_image(self, data: bytes) -> None:
        ct = "image/png"
        if data[:2] == b"\xff\xd8":
            ct = "image/jpeg"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            ct = "image/webp"
        elif data[:4] == b"GIF8":
            ct = "image/gif"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ct)
        # 带 &v=<内容版本> 的列表 URL → 内容变才换 URL，可长缓存（刷新不再重拉，和用户端 /api/avatar 一致）；
        # 预览用 &t=<时间戳> 强刷或无版本的 URL → no-store 总取最新（生成/重生后立刻看到）。
        if self._query("v"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        # 头像图片【不要求鉴权】：必须放在 auth 之前——<img> 请求带不了 Bearer，鉴权会 401 → 后台预览裂图。
        # 这本就是公开数据（用户端 /api/avatar 同样无鉴权下发），故安全等价。
        if self._route() == "/admin/avatar":
            from .characters_admin import load_avatar
            img = load_avatar(self._query("c"))
            if not img:
                return self._json(404, {"ok": False, "error": "no avatar"})
            return self._send_image(img)
        if not _authorized(self.headers):
            return self._json(401, {"error": "unauthorized"})
        if self._route() == "/admin/api-config":
            return self._json(200, read_config_for_admin())
        if self._route() == "/admin/voice-preview":   # 后台音色试听 → 真实 TTS 合成的 WAV（按角色或 voice_id）
            try:
                from .voice_preview import preview_wav
                return self._audio_wav(preview_wav(character_id=self._query("c"), voice_id=self._query("v")))
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)[:200]})
        if self._route() == "/admin/characters":
            from .characters_admin import read_characters_for_admin
            return self._json(200, {"characters": read_characters_for_admin()})
        if self._route() == "/admin/voices":   # MiniMax 系统（免费）音色库 + 克隆音色 + 各音色被哪些角色用
            from .characters_admin import effective_specs, load_cloned_voices
            from .voice_library import system_voice_library
            used: dict[str, list[str]] = {}
            for cid, spec in effective_specs().items():
                vid = ((spec.get("voice") or {}).get("voice_id") or "").strip()
                if vid:
                    used.setdefault(vid, []).append((spec.get("identity") or {}).get("name") or cid)
            lib = system_voice_library()
            sys_ids = {v["voice_id"] for v in lib}
            for v in lib:
                v["used_by"] = used.get(v["voice_id"], [])
            # 克隆/自定义音色：① 持久化清单里的；② 角色用了但不在系统库里的（兜住「先克隆过、清单还没记」的）。
            labels = {c.get("voice_id"): c.get("name") for c in load_cloned_voices()}
            custom_ids = set(labels) | {vid for vid in used if vid not in sys_ids}
            for vid in sorted(custom_ids - sys_ids):
                by = used.get(vid, [])
                name = labels.get(vid) or ((by[0] + " · 克隆") if by else vid)
                lib.append({"voice_id": vid, "name": name, "gender": "克隆音色", "group": "自定义",
                            "lang": "中文", "engine": "MiniMax", "cloned": True, "used_by": by})
            return self._json(200, {"voices": lib, "engine": "MiniMax"})
        if self._route() == "/admin/cost-config":
            return self._json(200, read_cost_for_admin())
        if self._route() == "/admin/default-character":
            from .characters_admin import load_default_character
            return self._json(200, {"id": load_default_character()})
        if self._route() == "/admin/invite-config":
            return self._json(200, read_invite_for_admin())
        # ── 看板真实数据（P4）：未注入仓储则返回空，前端退回演示数据 ──
        if self._route() == "/admin/stats":
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            return self._json(200, {"ok": True, "stats": _REPO.admin_stats(),
                                    "top_characters": _REPO.top_characters(limit=5),
                                    "trends": _REPO.call_trends(),
                                    "char_calls": _REPO.character_call_counts(),
                                    "scene_calls": _REPO.scenario_call_counts(),
                                    "invite_stats": _REPO.invite_overview(),
                                    "cost": _REPO.cost_summary()})
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
        if self._route() == "/admin/invites":
            if _REPO is None:
                return self._json(200, {"ok": False, "invites": []})
            return self._json(200, {"ok": True, "invites": _REPO.list_all_invites(limit=200)})
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
        if self._route() == "/admin/cost-config":
            try:
                write_cost_from_admin(self._body())
                return self._json(200, {"ok": True})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)[:200]})
        if self._route() == "/admin/default-character":
            try:
                from .characters_admin import set_default_character
                ok = set_default_character((self._body().get("id") or "").strip())
                return self._json(200 if ok else 400, {"ok": ok, "error": None if ok else "未知或已删除的角色"})
            except Exception as e:   # 写文件失败等：返回干净错误而非崩连接（其它写端点已有此保护）
                return self._json(500, {"ok": False, "error": str(e)[:200]})
        if self._route() == "/admin/invite-config":
            try:
                write_invite_from_admin(self._body())
                return self._json(200, {"ok": True})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)[:200]})
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
        if route == "/admin/redeem-codes":      # 自定义码 + 份数 + 时长
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            b = self._body()
            import secrets
            code = (b.get("code") or "").strip().upper() or ("MC-" + secrets.token_hex(3).upper())
            try:
                minutes = max(1, min(525600, int(b.get("minutes", 60) or 60)))   # 钳到 [1 分钟, 1 年]
            except (TypeError, ValueError):
                minutes = 60
            try:
                max_uses = max(1, min(100000, int(b.get("max_uses", 1) or 1)))
            except (TypeError, ValueError):
                max_uses = 1
            ok, msg = _REPO.create_redeem_code(code, minutes * 60, max_uses)
            return self._json(200, {"ok": ok, "code": code if ok else "", "error": None if ok else msg})
        if route == "/admin/redeem-codes/delete":   # 删除兑换码
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            ok = _REPO.delete_redeem_code((self._body().get("code") or "").strip())
            return self._json(200, {"ok": ok})
        if route == "/admin/users/ban":          # 封禁/解封用户：封后登录被拒、通话被拒
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            b = self._body()
            uid = (b.get("user_id") or "").strip()
            if not uid:
                return self._json(400, {"ok": False, "error": "缺少 user_id"})
            _REPO.set_user_banned(uid, bool(b.get("banned")))
            return self._json(200, {"ok": True})
        if route == "/admin/tickets/reply":     # 回复工单
            if _REPO is None:
                return self._json(200, {"ok": False, "error": "no repo"})
            b = self._body()
            ok = _REPO.reply_ticket(b.get("id"), (b.get("reply") or "").strip())
            return self._json(200, {"ok": ok})
        if route == "/admin/characters/create":   # 新建自定义角色
            try:
                from .characters_admin import create_character
                return self._json(200, {"ok": True, "id": create_character(self._body())})
            except Exception as e:
                return self._json(400, {"ok": False, "error": str(e)[:200]})
        if route == "/admin/characters/delete":   # 删除角色
            from .characters_admin import delete_character
            ok = delete_character((self._body().get("id") or "").strip())
            return self._json(200, {"ok": ok})
        if route == "/admin/generate-avatar":   # 给角色生成「半写实·柔光影棚」头像（走『生图』节点）
            from .avatar_gen import generate_for_character
            res = generate_for_character((self._body().get("id") or "").strip())
            return self._json(200 if res.get("ok") else 400, res)
        if route == "/admin/upload-avatar":   # 上传图片替代 AI 生成，存为该角色头像（原始字节，绕过 _body 的 JSON 限制）
            cid = self._query("c")
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0 or n > 15 * 1024 * 1024:
                return self._json(400, {"ok": False, "error": "图片为空或过大（≤15MB）"})
            data = self.rfile.read(n)
            if not cid:
                return self._json(400, {"ok": False, "error": "缺少角色 id"})
            try:
                from .characters_admin import avatar_url, save_avatar
                save_avatar(cid, data)   # save_avatar 内部会缩放+压缩
                return self._json(200, {"ok": True, "avatar": avatar_url(cid)})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)[:200]})
        if route == "/admin/voice-clone":   # 上传一段人声 → MiniMax 复刻 → 设为指定角色音色
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0 or n > 20 * 1024 * 1024:   # 原始音频体，绕过 _body 的 256KB/JSON 限制
                return self._json(400, {"ok": False, "error": "音频为空或过大（需 ≤20MB、5 分钟内）"})
            audio = self.rfile.read(n)
            from .voice_clone import clone_for_character
            res = clone_for_character(audio, self._query("name") or "voice.wav",
                                      character_id=self._query("c"), preview_text=self._query("text"))
            return self._json(200, res)
        if route == "/admin/characters/online":    # 下架/上架角色（下架=不对用户展示，仍在后台可改）
            from .characters_admin import set_character_offline
            b = self._body()
            ok = set_character_offline((b.get("id") or "").strip(), not bool(b.get("online", True)))
            return self._json(200 if ok else 400, {"ok": ok, "error": None if ok else "未知或已删除的角色"})
        if route == "/admin/characters/generate":  # AI 一键生成角色
            import asyncio

            from ..providers import make_eval_llm
            from .characters_admin import generate_character
            try:
                llm = make_eval_llm(load_config())   # 顶级评测脑（未配回退 llm_slow→llm_fast）
                fields = asyncio.run(generate_character((self._body().get("prompt") or "").strip(), llm))
                return self._json(200, {"ok": True, "fields": fields})
            except Exception as e:
                return self._json(400, {"ok": False, "error": str(e)[:200]})
        if route == "/admin/characters/generate-core":  # AI 一键生成内核（按现有维度提炼，填现成角色）
            import asyncio

            from ..providers import make_eval_llm
            from .characters_admin import generate_core
            try:
                llm = make_eval_llm(load_config())   # 顶级评测脑（未配回退 llm_slow→llm_fast）
                core = asyncio.run(generate_core(self._body() or {}, llm))
                return self._json(200, {"ok": True, "core": core})
            except Exception as e:
                return self._json(400, {"ok": False, "error": str(e)[:200]})
        self._json(404, {"error": "not found"})

    def log_message(self, *args) -> None:  # 静默（journalctl 不刷屏）
        pass


def run_admin_http(host: str = "127.0.0.1", port: int = 8788, repo=None) -> ThreadingHTTPServer:
    global _REPO
    _REPO = repo  # 看板数据用；为 None 时数据路由返回空，前端退回演示
    httpd = ThreadingHTTPServer((host, port), _Handler)
    threading.Thread(target=httpd.serve_forever, name="micall-admin-http", daemon=True).start()
    return httpd
