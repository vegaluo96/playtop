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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import auth as _auth

log = logging.getLogger("micall.userapi")
_REPO = None  # run_user_http 注入；与 SignalingServer.repo 同一实例


def _bearer(headers) -> str:
    return (headers.get("Authorization", "") or "").removeprefix("Bearer ").strip()


class _Handler(BaseHTTPRequestHandler):
    server_version = "MiCallUser/1.0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Credentials", "true")
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

    def _uid(self) -> str | None:
        """从 Bearer token 解析登录 user_id；未登录返回 None。"""
        return _REPO.user_for_token(_bearer(self.headers))

    def do_GET(self) -> None:
        route = self._route()
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
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        route = self._route()
        if route == "/api/auth/register":
            b = self._body()
            return self._json(*_auth.register(_REPO, b.get("email"), b.get("password")))
        if route == "/api/auth/login":
            b = self._body()
            return self._json(*_auth.login(_REPO, b.get("email"), b.get("password")))
        if route == "/api/auth/logout":
            return self._json(*_auth.logout(_REPO, _bearer(self.headers)))
        if route == "/api/redeem":
            uid = self._uid()
            if not uid:
                return self._json(401, {"ok": False, "error": "请先登录"})
            code = (self._body().get("code") or "").strip()
            if not code:
                return self._json(400, {"ok": False, "error": "请输入兑换码"})
            ok, remaining, msg = _REPO.redeem_code(uid, code)
            return self._json(200, {"ok": ok, "error": None if ok else msg,
                                    "message": msg, "remaining_seconds": remaining})
        self._json(404, {"error": "not found"})

    def log_message(self, *args) -> None:  # 静默
        pass


def run_user_http(repo, host: str = "127.0.0.1", port: int = 8789) -> ThreadingHTTPServer:
    global _REPO
    _REPO = repo
    httpd = ThreadingHTTPServer((host, port), _Handler)
    threading.Thread(target=httpd.serve_forever, name="micall-user-http", daemon=True).start()
    return httpd
