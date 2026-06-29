"""C 端用户账号 HTTP API —— 注册/登录/当前用户/登出。

契约（前端 logic/auth 调用，nginx 反代 /api/ → 本服务）：
  POST /api/auth/register  {email,password}        → {ok, token, user}
  POST /api/auth/login     {email,password}        → {ok, token, user}
  GET  /api/auth/me        (Authorization: Bearer) → {ok, user}
  POST /api/auth/logout    (Authorization: Bearer) → {ok}

与 adminapi（后台「接口配置」，仅 127.0.0.1 + nginx Basic Auth）分开：这是面向终端用户的公开接口。
零三方依赖：stdlib http.server 起本地线程，与 WS 信令服务**共用同一仓储实例**（run_user_http 注入），
保证 HTTP 注册的用户在 WS 握手时立刻可见（内存回退模式也一致）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import auth as _auth


def _user_allowed_origins() -> set:
    """用户端 CORS 白名单：仅 zsky 域；本地开发经 MICALL_USER_ALLOWED_ORIGINS 显式追加（逗号分隔）。"""
    out = {"https://zsky.com", "https://www.zsky.com"}
    for o in os.environ.get("MICALL_USER_ALLOWED_ORIGINS", "").split(","):
        o = o.strip()
        if o:
            out.add(o)
    return out

log = logging.getLogger("micall.userapi")
_REPO = None  # run_user_http 注入；与 SignalingServer.repo 同一实例
_CONFIG = None  # run_user_http 注入；供 /api/health 读各节点配置状态
GUEST_TRIAL_SECONDS = 600   # 兜底默认（10 分钟，按 IP 计）；真正生效值读 global_defaults.guest_trial_seconds（后台可改）
CONSENT_VERSION = "2026-06"   # 隐私政策/用户协议版本号；改版即升此值，留痕据此区分用户同意的是哪一版


def _guest_trial_seconds() -> int:
    """游客试用时长：以 global_defaults.guest_trial_seconds 为准（后台「成本与限流」可改、改完即生效），
    读不到则回退兜底常量。每次现读 load_config()（低频端点，确保与 wsserver 实际放行口径一致）。"""
    try:
        from ..config import load_config
        return int((load_config().global_defaults or {}).get("guest_trial_seconds", GUEST_TRIAL_SECONDS) or GUEST_TRIAL_SECONDS)
    except Exception:
        return GUEST_TRIAL_SECONDS

# ── 运维健康检查：抓「部署后某节点 key 没注入→静默退 stub（角色变哑/失忆）」这类故障 ──
_HEALTH_NODES = ("asr", "llm_fast", "tts", "llm_slow", "embedding", "llm_eval")
_HEALTH_CRITICAL = ("asr", "llm_fast", "tts")   # 这三个没配，通话本身就跑不起来（退 stub）


def health_snapshot(config, repo) -> dict:
    """健康快照（纯数据，便于测、被 /api/health 复用）：各节点是否真配了 endpoint+key、是否持久化。
    监控轮询此端点即可【先于用户】发现「某 key 部署后没生效」。注意：只查【是否配置】，查不出
    「key 配了但过期/失效」——那要真打一次上游（成本高），不放进健康检查。"""
    nodes: dict[str, bool] = {}
    for k in _HEALTH_NODES:
        try:
            nodes[k] = bool(config.node(k).configured)
        except Exception:
            nodes[k] = False
    try:
        persisted = type(repo).__name__ != "InMemoryRepository"
    except Exception:
        persisted = False
    degraded = [k for k in _HEALTH_CRITICAL if not nodes.get(k)]
    return {
        "ok": True,
        "status": "ok" if not degraded else "degraded",
        "degraded": degraded,      # 哪些关键节点没配（空=三件套齐活）
        "nodes": nodes,            # 全部 6 节点的 configured 状态
        "persisted": persisted,    # 跨通记忆是否在（false=内存模式，重启即忘）
    }

# ── 按 IP 限流（防刷：批量注册薅免费时长、登录/兑换码爆破）。进程内滑动窗口，单机足够 ──
_RATE: dict[tuple[str, str], list[float]] = {}
_RATE_LOCK = threading.Lock()
# 端点 → (窗口内最多次数, 窗口秒)
_RATE_RULES = {
    "register": (5, 3600),   # 同 IP 每小时最多 5 次注册（防批量薅 60 分钟）
    "login":    (15, 300),   # 5 分钟内 15 次（防密码爆破）
    "redeem":   (15, 300),   # 5 分钟内 15 次（防兑换码猜测）
}
# _RATE 只增不清会随独立 IP 数【无界增长】→ 慢性内存泄漏 → 终致 OOM 重启（在线通话全断）。
# 故每隔 _RATE_SWEEP_INTERVAL 顺手清一次「窗口内已无有效命中」的陈旧条目（锁内 O(条目数)，偶发）。
_RATE_SWEEP_INTERVAL = 600.0
_RATE_LAST_SWEEP = [0.0]   # 可变 cell 存上次清理时刻，免在热函数里写 global


def _rate_sweep(now: float) -> int:
    """清掉所有「窗口内已无有效命中」的 (ip,key) 条目。调用方须持 _RATE_LOCK。返回清掉条数（便于测/诊断）。"""
    dead = []
    for k, ts in _RATE.items():
        rule = _RATE_RULES.get(k[1])
        window = rule[1] if rule else 0
        if not any(now - t < window for t in ts):
            dead.append(k)
    for k in dead:
        _RATE.pop(k, None)
    return len(dead)


def _rate_ok(ip: str, key: str) -> bool:
    limit, window = _RATE_RULES[key]
    now = time.time()
    with _RATE_LOCK:
        if now - _RATE_LAST_SWEEP[0] > _RATE_SWEEP_INTERVAL:
            _RATE_LAST_SWEEP[0] = now
            _rate_sweep(now)
        hits = [t for t in _RATE.get((ip, key), []) if now - t < window]
        if len(hits) >= limit:
            _RATE[(ip, key)] = hits
            return False
        hits.append(now)
        _RATE[(ip, key)] = hits
        return True


def _bearer(headers) -> str:
    return (headers.get("Authorization", "") or "").removeprefix("Bearer ").strip()


class _Handler(BaseHTTPRequestHandler):
    server_version = "MiCallUser/1.0"

    def _cors(self) -> None:
        # 仅对白名单 Origin 反射并允许携带凭据；未知 Origin 不回 ACAO/ACAC。
        origin = (self.headers.get("Origin", "") or "").strip()
        if origin and origin in _user_allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    _MAX_BODY = 256 * 1024   # 请求体上限：用户端 JSON 都很小，挡无上限请求体

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > self._MAX_BODY:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, OSError):
            return {}

    def _audio_wav(self, data: bytes) -> None:
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_image(self, data: bytes) -> None:
        # 按魔数嗅探类型（生图上游可能回 png/jpeg/webp/gif）。URL 带 ?v=mtime 版本号，故可长缓存。
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
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/")

    def _query(self, key: str) -> str:
        from urllib.parse import parse_qs, urlparse
        return (parse_qs(urlparse(self.path).query).get(key, [""])[0] or "").strip()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _uid(self) -> str | None:
        """从 Bearer token 解析登录 user_id；未登录返回 None。"""
        return _REPO.user_for_token(_bearer(self.headers))

    def _ip(self) -> str:
        """客户端真实 IP（nginx 转发的 X-Forwarded-For / X-Real-IP，回退对端地址）。"""
        xff = self.headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        xri = self.headers.get("X-Real-IP")
        if xri:
            return xri.strip()
        return self.client_address[0] if self.client_address else "unknown"

    def do_GET(self) -> None:
        route = self._route()
        if route == "/api/health":          # 公开：运维健康检查（节点配置/持久化），无鉴权，供监控轮询
            try:
                from ..config import load_config
                cfg = _CONFIG or load_config()
                return self._json(200, health_snapshot(cfg, _REPO))
            except Exception as e:
                return self._json(200, {"ok": False, "status": "error", "error": str(e)[:200]})
        if route == "/api/characters":      # 公开：用户端角色卡列表（含运营新建、剔除已删除）
            try:
                from .characters_admin import public_characters
                return self._json(200, {"ok": True, "characters": public_characters()})
            except Exception as e:
                return self._json(200, {"ok": False, "characters": [], "error": str(e)[:200]})
        if route == "/api/guest-trial":      # 公开：本 IP 剩余试用秒（刷新不重置）
            return self._json(200, {"ok": True, "remaining_seconds": _REPO.guest_trial_remaining(self._ip(), _guest_trial_seconds())})
        if route == "/api/invite-reward":     # 公开：后台配置的邀请奖励 + 注册赠送（分钟），登录与否都拿真实值（不再写死 60）
            try:
                from .auth import register_gift_seconds
                gift_min = register_gift_seconds() // 60
            except Exception:
                gift_min = 60
            return self._json(200, {"ok": True, "reward_minutes": _auth.invite_reward_seconds() // 60,
                                    "register_gift_minutes": gift_min})
        if route == "/api/voice-preview":     # 公开：角色音色试听 → 真实 TTS 合成的 WAV（非占位动画）
            try:
                from .voice_preview import preview_wav
                return self._audio_wav(preview_wav(character_id=self._query("c"), voice_id=self._query("v")))
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)[:200]})
        if route == "/api/avatar":            # 公开：后台生成的角色头像（图片字节）；无则 404 → 前端回退渐变球
            from .characters_admin import load_avatar
            img = load_avatar(self._query("c"))
            if not img:
                return self._json(404, {"ok": False, "error": "no avatar"})
            return self._send_image(img)
        if route == "/api/voices":            # 公开：真实可选音色库（MiniMax 系统音色）+（登录则）我每个角色已选音色
            from .voice_library import system_voice_library
            uid = self._uid()                 # 带合法 token 才回显选中态；游客只拿库
            mine = _REPO.list_user_voices(uid) if uid else {}
            return self._json(200, {"ok": True, "voices": system_voice_library(), "mine": mine})
        if route == "/api/character-status":   # 公开：角色「状态」——TA 当下的心情/近况/精力（§4.1 自主状态，per-角色）
            cid = self._query("c")
            if not cid:
                return self._json(400, {"ok": False, "error": "缺少角色"})
            from .characters_admin import effective_autonomous
            st = effective_autonomous(_REPO, cid)   # DB 有真实状态用 DB，否则回退出厂初始近况
            has = bool(st.mood or st.recent_experience or st.energy or st.anticipating)
            return self._json(200, {"ok": True, "status": {
                "mood": st.mood, "recent": st.recent_experience, "energy": st.energy,
                "anticipating": st.anticipating, "has": has}})
        if route == "/api/memories":           # 「回忆」——你和这个角色之间的关系/聊过的事（per-user×角色，需登录）
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "请先登录"})
            cid = self._query("c")
            if not cid:
                return self._json(400, {"ok": False, "error": "缺少角色"})
            prof = _REPO.get_profile(uid, cid)
            rel = prof.relationship
            facts = _REPO.recall(uid, cid, "", top_k=8)   # 最近若干条记忆（pg：空 query→取最近）
            has = bool(rel.last_topic or rel.shared_refs or rel.open_threads or facts
                       or (rel.stage and rel.stage != "初识"))
            return self._json(200, {"ok": True, "memory": {
                "stage": rel.stage, "last_topic": rel.last_topic, "last_mood": rel.last_mood,
                "shared_refs": rel.shared_refs, "open_threads": rel.open_threads,
                "facts": facts, "has": has}})
        if route == "/api/auth/me":
            return self._json(*_auth.me(_REPO, _bearer(self.headers)))
        if route == "/api/calls":
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            return self._json(200, {"ok": True, "calls": _REPO.list_calls(uid, limit=30)})
        if route == "/api/bills":
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            return self._json(200, {"ok": True, "bills": _REPO.list_ledger(uid, limit=30)})
        if route == "/api/tickets":
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            return self._json(200, {"ok": True, "tickets": _REPO.list_user_tickets(uid, limit=30)})
        if route == "/api/notifications":   # 轻量通知轮询（H5 无推送）：返回服务端「真实未读」信号，前端与本地已读时间比对出红点
            uid = self._uid()
            if not uid:
                return self._json(200, {"ok": True, "ticket_reply_at": ""})   # 游客无工单，静默返回空（不挡轮询）
            return self._json(200, {"ok": True, "ticket_reply_at": _REPO.latest_reply_at(uid)})
        if route == "/api/invite":
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            inv = _REPO.invite_stats(uid)
            inv["reward_minutes"] = _auth.invite_reward_seconds() // 60   # 后台配置的每邀请奖励（前端展示）
            return self._json(200, {"ok": True, "invite": inv})
        if route == "/api/favorites":          # 账号级收藏（需登录）→ 跨设备同步
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            return self._json(200, {"ok": True, "favorites": _REPO.list_favorites(uid)})
        if route == "/api/popular":            # 公开：各角色累计通话数 → 用户端「热门」真实排序
            return self._json(200, {"ok": True, "counts": _REPO.char_call_counts()})
        self._json(404, {"error": "not found"})

    def _rate_block(self, key: str) -> bool:
        if not _rate_ok(self._ip(), key):
            self._json(429, {"ok": False, "error": "操作过于频繁，请稍后再试"})
            return True
        return False

    def do_POST(self) -> None:
        route = self._route()
        if route == "/api/auth/register":
            if self._rate_block("register"):
                return
            b = self._body()
            return self._json(*_auth.register(_REPO, b.get("email"), b.get("password"), b.get("invite_code") or ""))
        if route == "/api/auth/login":
            if self._rate_block("login"):
                return
            b = self._body()
            return self._json(*_auth.login(_REPO, b.get("email"), b.get("password")))
        if route == "/api/auth/logout":
            return self._json(*_auth.logout(_REPO, _bearer(self.headers)))
        if route == "/api/auth/change-password":
            return self._json(*_auth.change_password(_REPO, _bearer(self.headers), (self._body().get("new_password") or "")))
        if route == "/api/consent":   # 同意留痕（合规）：协议版本+时间+账号(可空=游客)+IP。公开，登录与否都记
            b = self._body()
            kind = (b.get("kind") or "cookie").strip()[:20]
            if kind not in ("cookie", "register", "terms"):
                kind = "cookie"
            try:
                _REPO.record_consent(kind, CONSENT_VERSION, user_id=self._uid() or "", ip=self._client_ip())
            except Exception as e:
                log.warning("consent 记录失败（忽略）：%r", e)
            return self._json(200, {"ok": True, "version": CONSENT_VERSION})
        if route == "/api/redeem":
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "请先登录"})
            if self._rate_block("redeem"):
                return
            code = (self._body().get("code") or "").strip()
            if not code:
                return self._json(400, {"ok": False, "error": "请输入兑换码"})
            ok, remaining, msg = _REPO.redeem_code(uid, code)
            return self._json(200, {"ok": ok, "error": None if ok else msg,
                                    "message": msg, "remaining_seconds": remaining})
        if route == "/api/calls/delete":   # 用户端删除（隐藏）通话记录：账号级，跨设备一致；后台统计不受影响
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            ids = self._body().get("ids")
            n = _REPO.hide_calls(uid, ids if isinstance(ids, list) else [])
            return self._json(200, {"ok": True, "deleted": n})
        if route == "/api/favorites":      # 账号级收藏：单条切换 {character_id,on}，或登录时把本地收藏并入账号 {merge:[ids]}
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            b = self._body()
            merge = b.get("merge")
            if isinstance(merge, list):       # 登录合并：本地收藏并入账号（取并集，手机+PC 都不丢）
                for cid in merge:
                    if isinstance(cid, str) and cid:
                        _REPO.set_favorite(uid, cid, True)
            else:
                cid = (b.get("character_id") or "").strip()
                if not cid:
                    return self._json(400, {"ok": False, "error": "缺少角色"})
                _REPO.set_favorite(uid, cid, bool(b.get("on", True)))
            return self._json(200, {"ok": True, "favorites": _REPO.list_favorites(uid)})
        if route == "/api/voice":        # 设定本账号某角色的音色：账号级、跨设备一致，下一通即生效（后端 get_user_voice）
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "未登录"})
            from .voice_library import voice_ids
            b = self._body()
            cid = (b.get("character_id") or "").strip()
            vid = (b.get("voice_id") or "").strip()
            if not cid:
                return self._json(400, {"ok": False, "error": "无效音色"})
            if vid == "default":                    # 「原本音色」：清掉覆盖 → 通话回退角色出厂默认
                _REPO.clear_user_voice(uid, cid)
                return self._json(200, {"ok": True})
            if vid not in voice_ids():               # 只接受真实库里的 voice_id，杜绝写入用不了的假值
                return self._json(400, {"ok": False, "error": "无效音色"})
            _REPO.set_user_voice(uid, cid, vid)
            return self._json(200, {"ok": True})
        if route == "/api/voice-match":  # 自定义音色：用户一句话描述 → LLM 在免费音色库里匹配一个真实 voice_id
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "请先登录"})
            desc = (self._body().get("desc") or "").strip()
            if not desc:
                return self._json(400, {"ok": False, "error": "描述一下你想要的声音吧"})
            from .voice_match import match_voice
            return self._json(200, {"ok": True, "voice": match_voice(desc[:200])})
        if route == "/api/tickets":      # 提交工单
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "请先登录"})
            b = self._body()
            msg = (b.get("message") or "").strip()
            if not msg:
                return self._json(400, {"ok": False, "error": "请描述你的问题"})
            tid = _REPO.add_ticket(uid, (b.get("type") or "").strip(), msg)
            return self._json(200, {"ok": True, "id": tid})
        if route == "/api/rate-call":    # 通话评价：星级(1–5)+反馈标签 → 写进画像 reply_calibration，下一通让 AI 据真人反馈校准
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "请先登录"})
            b = self._body()
            cid = (b.get("character_id") or "").strip()
            try:
                rating = int(b.get("rating") or 0)
            except (TypeError, ValueError):
                rating = 0
            fb = b.get("feedback")
            feedback = [t for t in fb if isinstance(t, str)][:8] if isinstance(fb, list) else []
            if not cid or not (1 <= rating <= 5):
                return self._json(400, {"ok": False, "error": "无效评价"})
            note = _REPO.record_call_feedback(uid, cid, rating, feedback)
            return self._json(200, {"ok": True, "calibrated": bool(note)})
        self._json(404, {"error": "not found"})

    def log_message(self, *args) -> None:  # 静默
        pass


def run_user_http(repo, host: str = "127.0.0.1", port: int = 8789, config=None) -> ThreadingHTTPServer:
    global _REPO, _CONFIG
    _REPO = repo
    _CONFIG = config   # 供 /api/health 读节点配置（None 则按需 load_config 兜底）
    httpd = ThreadingHTTPServer((host, port), _Handler)
    threading.Thread(target=httpd.serve_forever, name="micall-user-http", daemon=True).start()
    return httpd
