"""记忆仓储（docs/02 §3.1：事实层与理解层**物理分开**）。

  • 事实层：客观、只增、可检索（真实存 Postgres + pgvector）。
  • 理解层：主观、持续修正、有置信度（真实存 Postgres 结构化 JSONB）。
  • user_voice：§6.1 三级覆盖的"用户自定义"层载体。

接口纯抽象；InMemoryRepository 是零依赖实现，供骨架运行与测试。真实实现 PgRepository
用 asyncpg + pgvector（schema 见 memory/schema.sql）。
"""
from __future__ import annotations

import math
import time
from abc import ABC, abstractmethod

from ..context.models import AutonomousState, UserProfile


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _cosine(a: list[float], b: list[float]) -> float:
    """余弦相似度；维度不一致/零向量 → 0。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = na = nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / math.sqrt(na * nb)


class MemoryRepository(ABC):
    # ── 事实层 ──
    @abstractmethod
    def add_fact(
        self, user_id: str, character_id: str, text: str, *,
        emotion_weight: float = 1.0, vector: list[float] | None = None,
    ) -> None: ...

    @abstractmethod
    def recall(self, user_id: str, character_id: str, query: str, *, top_k: int = 5) -> list[str]:
        """情节检索（关键词近似；无向量时的兜底）。返回原始片段，注入前由 assembler 自然化（§3.5）。"""

    def recall_vec(
        self, user_id: str, character_id: str, query_vector: list[float], *,
        query: str = "", top_k: int = 5,
    ) -> list[str]:
        """向量检索（余弦相似 × 情感权重 × 新近）。默认实现回退关键词 recall（子类可覆写）。"""
        return self.recall(user_id, character_id, query, top_k=top_k)

    def has_facts(self, user_id: str, character_id: str) -> bool:
        """是否有可检索的事实。无则编排层跳过 query 向量化（省一次实时往返）。默认保守返 True。"""
        return True

    def reset_memory(self, user_id: str, character_id: str) -> None:
        """忘记这段关系：清空该 user×char 的事实层 + 理解层（画像/关系/策略）。前端「重置记忆」。
        不动出厂角色定义与用户自定义音色。子类按存储实现。"""

    def seed_characters(self, specs: dict) -> None:
        """把出厂角色写入存储（facts/profile 的 FK 前置）。内存实现无需，DB 实现覆写。"""

    def ensure_user(self, user_id: str, **kw) -> None:
        """确保用户行存在（FK 前置）。内存实现无需，DB 实现覆写。"""

    # ── 理解层 ──
    @abstractmethod
    def get_profile(self, user_id: str, character_id: str) -> UserProfile: ...

    @abstractmethod
    def save_profile(self, profile: UserProfile) -> None: ...

    # ── 用户自定义音色（§6.1）──
    @abstractmethod
    def get_user_voice(self, user_id: str, character_id: str) -> str | None: ...

    @abstractmethod
    def set_user_voice(self, user_id: str, character_id: str, voice_id: str, label: str = "") -> None: ...

    # ── 角色自主状态（§4.1，per-character，独立于用户）──
    @abstractmethod
    def get_autonomous(self, character_id: str) -> AutonomousState: ...

    @abstractmethod
    def save_autonomous(self, character_id: str, state: AutonomousState) -> None: ...

    # ── 用户账号 / 登录会话 / 计费余额（P2/P3）──
    # 基类给「游客安全」缺省（不支持账号）；InMemoryRepository 与 PgRepository 给真实实现。
    def create_user(
        self, user_id: str, email: str, password_hash: str, *,
        display_name: str = "", gift_seconds: int = 0,
    ) -> bool:
        """新建用户；email 已注册返回 False。gift_seconds 入账并记 register_gift 流水。"""
        return False

    def auth_user(self, email: str) -> tuple[str, str] | None:
        """email → (user_id, password_hash)；无则 None。登录校验用。"""
        return None

    def get_user(self, user_id: str) -> dict | None:
        """user_id → {user_id,email,display_name,remaining_seconds}；无则 None。"""
        return None

    def create_session(self, token: str, user_id: str, ttl_seconds: int) -> None:
        """登录发 token：记 token→user_id，ttl_seconds 后过期。"""

    def user_for_token(self, token: str) -> str | None:
        """token → user_id（未过期）；无效/过期则 None。WS 握手与 /api/auth/me 用。"""
        return None

    def delete_session(self, token: str) -> None:
        """登出：作废 token。"""

    def remaining_seconds(self, user_id: str) -> int:
        """用户当前余额（秒，服务端权威）。"""
        return 0

    def add_seconds(self, user_id: str, delta_seconds: int, reason: str) -> int:
        """改余额并记流水（负=消费 call、正=充值 recharge/赠送）。返回改后余额（钳到 ≥0）。"""
        return 0

    # ── 通话记录 / 账单（P3）──
    def add_call(self, user_id: str, character_id: str, scenario: str,
                 duration_seconds: int, ended_reason: str) -> None:
        """通话结束写一条记录（前端「通话历史」数据源）。"""

    def list_calls(self, user_id: str, *, limit: int = 30) -> list[dict]:
        """该用户最近通话，新→旧。每条 {character_id,scenario,duration_seconds,ended_reason,started_at}。"""
        return []

    def list_ledger(self, user_id: str, *, limit: int = 30) -> list[dict]:
        """该用户计费流水，新→旧。每条 {delta_seconds,reason,created_at}。前端「账单明细」数据源。"""
        return []

    # ── 后台看板聚合（P4，全站只读）──
    def admin_stats(self) -> dict:
        """后台首页 KPI：{total_users, calls_today, total_minutes, month_revenue_cents}。"""
        return {"total_users": 0, "calls_today": 0, "total_minutes": 0, "month_revenue_cents": 0}

    def list_all_users(self, *, limit: int = 200) -> list[dict]:
        """全站用户（后台「用户」）：{user_id,email,remaining_seconds,created_at,total_calls,total_seconds}。"""
        return []

    def list_all_calls(self, *, limit: int = 200) -> list[dict]:
        """全站通话（后台「通话」）：{user_email,character_id,scenario,duration_seconds,ended_reason,started_at}。"""
        return []

    def list_all_orders(self, *, limit: int = 200) -> list[dict]:
        """全站订单（后台「订单」）：{order_id,user_email,plan,amount_cents,status,created_at}。"""
        return []

    def top_characters(self, *, limit: int = 5) -> list[dict]:
        """按通话量排名的角色：{character_id, calls}。后台首页「热门角色」。"""
        return []

    # ── 兑换码（P5：后台生成、用户核销充值）──
    def create_redeem_codes(self, count: int, seconds: int) -> list[str]:
        """批量生成兑换码（每个值 seconds），返回码列表。后台「兑换码」用。"""
        return []

    def redeem_code(self, user_id: str, code: str) -> tuple[bool, int, str]:
        """用户核销兑换码：未用过则入账 seconds + 记 redeem 流水。返回 (是否成功, 改后余额, 提示)。"""
        return False, 0, "暂不支持"

    def list_redeem_codes(self, *, limit: int = 200) -> list[dict]:
        """兑换码列表（后台）：{code,seconds,used_by_email,used_at,created_at}。"""
        return []

    # ── 工单（用户反馈 / 客服）──
    def add_ticket(self, user_id: str, type: str, message: str) -> int:
        """用户提交工单，返回 id。"""
        return 0

    def list_user_tickets(self, user_id: str, *, limit: int = 30) -> list[dict]:
        """该用户的工单：{type,message,status,reply,created_at}。"""
        return []

    def list_all_tickets(self, *, limit: int = 200) -> list[dict]:
        """全站工单（后台）：{id,user_email,type,message,status,reply,created_at}。"""
        return []

    def reply_ticket(self, ticket_id: int, reply: str) -> bool:
        """后台回复工单（status→replied）。"""
        return False


class InMemoryRepository(MemoryRepository):
    """字典实现。配了 Embedding 节点则按余弦相似召回（recall_vec），否则字符重叠近似（recall）。
    真实部署换 PgRepository（pgvector 余弦 + 持久化）。"""

    def __init__(self) -> None:
        # 每条事实：(text, emotion_weight, vector|None)
        self._facts: dict[tuple[str, str], list[tuple[str, float, list[float] | None]]] = {}
        self._profiles: dict[tuple[str, str], UserProfile] = {}
        self._voices: dict[tuple[str, str], str] = {}
        self._autonomous: dict[str, AutonomousState] = {}
        self._users: dict[str, dict] = {}                  # user_id → 账号
        self._email_idx: dict[str, str] = {}               # email(lower) → user_id
        self._sessions: dict[str, tuple[str, float]] = {}  # token → (user_id, expires_epoch)
        self._calls: list[dict] = []                       # 通话记录（含 user_id）
        self._ledger: list[dict] = []                      # 计费流水（含 user_id）
        self._orders: list[dict] = []                      # 充值订单（保留：支付接入时写入）
        self._redeem: dict[str, dict] = {}                 # code → 兑换码
        self._tickets: list[dict] = []                     # 工单（含 user_id）
        self._tid = 0                                      # 工单自增 id

    def add_fact(
        self, user_id: str, character_id: str, text: str, *,
        emotion_weight: float = 1.0, vector: list[float] | None = None,
    ) -> None:
        self._facts.setdefault((user_id, character_id), []).append((text, emotion_weight, vector))

    def has_facts(self, user_id: str, character_id: str) -> bool:
        return bool(self._facts.get((user_id, character_id)))

    def reset_memory(self, user_id: str, character_id: str) -> None:
        self._facts.pop((user_id, character_id), None)       # 事实层
        self._profiles.pop((user_id, character_id), None)    # 理解层（画像/关系/策略）

    def recall(self, user_id: str, character_id: str, query: str, *, top_k: int = 5) -> list[str]:
        items = self._facts.get((user_id, character_id), [])
        if not items:
            return []
        q = set(query)
        # 近似分 = 字符重叠 × 情感权重 × 越近越重（list 末尾更新，给递增的新近加成）。
        scored = [
            (len(q & set(text)) * weight * (1 + i / max(1, len(items))), text)
            for i, (text, weight, _v) in enumerate(items)
        ]
        scored.sort(key=lambda s: s[0], reverse=True)
        return [text for score, text in scored[:top_k] if score > 0]

    def recall_vec(
        self, user_id: str, character_id: str, query_vector: list[float], *,
        query: str = "", top_k: int = 5,
    ) -> list[str]:
        items = self._facts.get((user_id, character_id), [])
        if not items or not query_vector:
            return self.recall(user_id, character_id, query, top_k=top_k)
        n = len(items)
        scored: list[tuple[float, str]] = []
        any_vec = False
        for i, (text, weight, vec) in enumerate(items):
            if vec:
                any_vec = True
                # 余弦相似 × 情感权重 × 新近加成（末尾更近）。
                scored.append((_cosine(query_vector, vec) * weight * (1 + i / max(1, n)), text))
        if not any_vec:  # 库里还没有向量（旧数据/未向量化）→ 退关键词。
            return self.recall(user_id, character_id, query, top_k=top_k)
        scored.sort(key=lambda s: s[0], reverse=True)
        return [text for score, text in scored[:top_k] if score > 0]

    def get_profile(self, user_id: str, character_id: str) -> UserProfile:
        return self._profiles.get(
            (user_id, character_id), UserProfile(user_id=user_id, character_id=character_id)
        )

    def save_profile(self, profile: UserProfile) -> None:
        self._profiles[(profile.user_id, profile.character_id)] = profile

    def get_user_voice(self, user_id: str, character_id: str) -> str | None:
        return self._voices.get((user_id, character_id))

    def set_user_voice(self, user_id: str, character_id: str, voice_id: str, label: str = "") -> None:
        self._voices[(user_id, character_id)] = voice_id

    def get_autonomous(self, character_id: str) -> AutonomousState:
        return self._autonomous.get(character_id, AutonomousState())

    def save_autonomous(self, character_id: str, state: AutonomousState) -> None:
        self._autonomous[character_id] = state

    # ── 账号/会话/计费（内存）──
    def create_user(self, user_id, email, password_hash, *, display_name="", gift_seconds=0) -> bool:
        key = (email or "").strip().lower()
        if key and key in self._email_idx:
            return False
        self._users[user_id] = {
            "user_id": user_id, "email": email, "display_name": display_name,
            "password_hash": password_hash, "remaining_seconds": max(0, int(gift_seconds)),
            "created_at": _now_iso(),
        }
        if key:
            self._email_idx[key] = user_id
        if gift_seconds:
            self._ledger.append({
                "user_id": user_id, "delta_seconds": int(gift_seconds),
                "reason": "register_gift", "created_at": _now_iso(),
            })
        return True

    def auth_user(self, email):
        uid = self._email_idx.get((email or "").strip().lower())
        return (uid, self._users[uid]["password_hash"]) if uid else None

    def get_user(self, user_id):
        u = self._users.get(user_id)
        return {k: u[k] for k in ("user_id", "email", "display_name", "remaining_seconds")} if u else None

    def create_session(self, token, user_id, ttl_seconds) -> None:
        self._sessions[token] = (user_id, time.time() + ttl_seconds)

    def user_for_token(self, token):
        rec = self._sessions.get(token)
        if not rec:
            return None
        uid, exp = rec
        if exp < time.time():
            self._sessions.pop(token, None)
            return None
        return uid

    def delete_session(self, token) -> None:
        self._sessions.pop(token, None)

    def remaining_seconds(self, user_id) -> int:
        u = self._users.get(user_id)
        return int(u["remaining_seconds"]) if u else 0

    def add_seconds(self, user_id, delta_seconds, reason) -> int:
        u = self._users.get(user_id)
        if not u:
            return 0
        u["remaining_seconds"] = max(0, int(u["remaining_seconds"]) + int(delta_seconds))
        self._ledger.append({
            "user_id": user_id, "delta_seconds": int(delta_seconds),
            "reason": reason, "created_at": _now_iso(),
        })
        return u["remaining_seconds"]

    def add_call(self, user_id, character_id, scenario, duration_seconds, ended_reason) -> None:
        self._calls.append({
            "user_id": user_id, "character_id": character_id, "scenario": scenario or "",
            "duration_seconds": int(duration_seconds), "ended_reason": ended_reason or "ended",
            "started_at": _now_iso(),
        })

    def list_calls(self, user_id, *, limit=30) -> list[dict]:
        rows = [c for c in self._calls if c["user_id"] == user_id]
        rows.sort(key=lambda c: c["started_at"], reverse=True)
        return [{k: c[k] for k in ("character_id", "scenario", "duration_seconds", "ended_reason", "started_at")}
                for c in rows[:limit]]

    def list_ledger(self, user_id, *, limit=30) -> list[dict]:
        rows = [b for b in self._ledger if b["user_id"] == user_id]
        return [{k: b[k] for k in ("delta_seconds", "reason", "created_at")} for b in rows[::-1][:limit]]

    # ── 后台看板聚合（内存）──
    def admin_stats(self) -> dict:
        today = _now_iso()[:10]
        return {
            "total_users": len(self._users),
            "calls_today": sum(1 for c in self._calls if c["started_at"][:10] == today),
            "total_minutes": sum(c["duration_seconds"] for c in self._calls) // 60,
            "month_revenue_cents": sum(o.get("amount_cents", 0) for o in self._orders if o.get("status") == "paid"),
        }

    def list_all_users(self, *, limit=200) -> list[dict]:
        out = []
        for u in self._users.values():
            mine = [c for c in self._calls if c["user_id"] == u["user_id"]]
            out.append({
                "user_id": u["user_id"], "email": u.get("email") or "",
                "remaining_seconds": u["remaining_seconds"], "created_at": u.get("created_at", ""),
                "total_calls": len(mine), "total_seconds": sum(c["duration_seconds"] for c in mine),
            })
        out.sort(key=lambda x: x["created_at"], reverse=True)
        return out[:limit]

    def list_all_calls(self, *, limit=200) -> list[dict]:
        email = {u["user_id"]: (u.get("email") or "") for u in self._users.values()}
        rows = sorted(self._calls, key=lambda c: c["started_at"], reverse=True)[:limit]
        return [{
            "user_email": email.get(c["user_id"], ""), "character_id": c["character_id"],
            "scenario": c["scenario"], "duration_seconds": c["duration_seconds"],
            "ended_reason": c["ended_reason"], "started_at": c["started_at"],
        } for c in rows]

    def list_all_orders(self, *, limit=200) -> list[dict]:
        email = {u["user_id"]: (u.get("email") or "") for u in self._users.values()}
        rows = sorted(self._orders, key=lambda o: o.get("created_at", ""), reverse=True)[:limit]
        return [{
            "order_id": o.get("order_id", ""), "user_email": email.get(o.get("user_id"), ""),
            "plan": o.get("plan", ""), "amount_cents": o.get("amount_cents", 0),
            "status": o.get("status", ""), "created_at": o.get("created_at", ""),
        } for o in rows]

    def top_characters(self, *, limit=5) -> list[dict]:
        from collections import Counter
        cnt = Counter(c["character_id"] for c in self._calls)
        return [{"character_id": cid, "calls": n} for cid, n in cnt.most_common(limit)]

    # ── 兑换码（内存）──
    def create_redeem_codes(self, count, seconds) -> list[str]:
        import secrets
        codes = []
        for _ in range(max(1, int(count))):
            code = "MC-" + "-".join(secrets.token_hex(2).upper() for _ in range(3))
            self._redeem[code] = {"code": code, "seconds": int(seconds), "used_by": None,
                                  "used_at": None, "created_at": _now_iso()}
            codes.append(code)
        return codes

    def redeem_code(self, user_id, code) -> tuple[bool, int, str]:
        rec = self._redeem.get((code or "").strip().upper())
        if not rec:
            return False, self.remaining_seconds(user_id), "兑换码无效"
        if rec["used_by"]:
            return False, self.remaining_seconds(user_id), "兑换码已被使用"
        rec["used_by"], rec["used_at"] = user_id, _now_iso()
        bal = self.add_seconds(user_id, rec["seconds"], "redeem")
        return True, bal, f"成功充值 {rec['seconds'] // 60} 分钟"

    def list_redeem_codes(self, *, limit=200) -> list[dict]:
        email = {u["user_id"]: (u.get("email") or "") for u in self._users.values()}
        rows = sorted(self._redeem.values(), key=lambda r: r["created_at"], reverse=True)[:limit]
        return [{"code": r["code"], "seconds": r["seconds"], "used_by_email": email.get(r["used_by"], ""),
                 "used_at": r["used_at"] or "", "created_at": r["created_at"]} for r in rows]

    # ── 工单（内存）──
    def add_ticket(self, user_id, type, message) -> int:
        self._tid += 1
        self._tickets.append({"id": self._tid, "user_id": user_id, "type": type or "", "message": message,
                              "status": "open", "reply": "", "created_at": _now_iso()})
        return self._tid

    def list_user_tickets(self, user_id, *, limit=30) -> list[dict]:
        rows = [t for t in self._tickets if t["user_id"] == user_id][::-1][:limit]
        return [{k: t[k] for k in ("type", "message", "status", "reply", "created_at")} for t in rows]

    def list_all_tickets(self, *, limit=200) -> list[dict]:
        email = {u["user_id"]: (u.get("email") or "") for u in self._users.values()}
        rows = sorted(self._tickets, key=lambda t: t["created_at"], reverse=True)[:limit]
        return [{"id": t["id"], "user_email": email.get(t["user_id"], ""), "type": t["type"],
                 "message": t["message"], "status": t["status"], "reply": t["reply"],
                 "created_at": t["created_at"]} for t in rows]

    def reply_ticket(self, ticket_id, reply) -> bool:
        for t in self._tickets:
            if t["id"] == int(ticket_id):
                t["reply"], t["status"] = reply, "replied"
                return True
        return False
