"""C 端用户账号鉴权（注册 / 登录 / 当前用户 / 登出）。

纯逻辑 + 仓储调用，便于测试。密码用 pbkdf2-hmac-sha256（标准库，无三方依赖）；登录态用
随机 token 存 sessions 表。与后台 admin 鉴权（adminapi.py，管「接口配置」）完全分离——
这里管的是终端用户。HTTP 入口见 userapi.py；WS 握手用同一 token 解析出 user_id（替换游客 _ANON）。
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets

REGISTER_GIFT_SECONDS = 3600          # 注册赠送 60 分钟（对齐前端「已送 60 分钟」文案）
SESSION_TTL_SECONDS = 30 * 24 * 3600  # token 有效期 30 天
_PBKDF2_ITERS = 200_000
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = (stored or "").split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


def _public(u: dict) -> dict:
    """对外只暴露安全字段（绝不带 password_hash）。"""
    return {
        "user_id": u["user_id"],
        "email": u.get("email") or "",
        "display_name": u.get("display_name") or "",
        "remaining_seconds": int(u.get("remaining_seconds") or 0),
    }


def _issue(repo, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    repo.create_session(token, user_id, SESSION_TTL_SECONDS)
    return token


def register(repo, email: str, password: str) -> tuple[int, dict]:
    email = (email or "").strip()
    password = password or ""
    if not _EMAIL_RE.match(email):
        return 400, {"ok": False, "error": "邮箱格式不对"}
    if len(password) < 6:
        return 400, {"ok": False, "error": "密码至少 6 位"}
    user_id = "u_" + secrets.token_hex(8)
    if not repo.create_user(user_id, email, hash_password(password), gift_seconds=REGISTER_GIFT_SECONDS):
        return 409, {"ok": False, "error": "该邮箱已注册"}
    user = repo.get_user(user_id) or {"user_id": user_id, "email": email, "remaining_seconds": REGISTER_GIFT_SECONDS}
    return 200, {"ok": True, "token": _issue(repo, user_id), "user": _public(user)}


def login(repo, email: str, password: str) -> tuple[int, dict]:
    row = repo.auth_user((email or "").strip())
    if not row or not verify_password(password or "", row[1]):
        return 401, {"ok": False, "error": "邮箱或密码错误"}
    user = repo.get_user(row[0]) or {"user_id": row[0], "email": email}
    return 200, {"ok": True, "token": _issue(repo, row[0]), "user": _public(user)}


def me(repo, token: str) -> tuple[int, dict]:
    uid = repo.user_for_token(token or "")
    if not uid:
        return 401, {"ok": False, "error": "未登录"}
    user = repo.get_user(uid)
    if not user:
        return 401, {"ok": False, "error": "用户不存在"}
    return 200, {"ok": True, "user": _public(user)}


def logout(repo, token: str) -> tuple[int, dict]:
    if token:
        repo.delete_session(token)
    return 200, {"ok": True}
