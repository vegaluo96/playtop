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


def stable_invite_code(user_id: str, attempt: int = 0) -> str:
    """邀请码 = 账号的【确定性函数】，不是随机值。第一性原理：随机码必须靠写库/内存才稳定，
    一旦 user 行缺失(外键失败)、进程重启、或换了实例，旧码就丢、下次现编一个新的 → 用户看到「邀请码
    总是变来变去」。改成从 user_id 派生：同一个人永远算出同一个码，天生不漂移、不依赖任何一次写库成功。
    blake2b 4 字节 ≈ 40 亿空间，撞码概率可忽略；万一撞到别人已占用的码，调用方用 attempt 加盐重算换一个。
    带固定盐避免直接从 user_id 枚举（邀请码本就公开分享，安全性要求低，够用）。"""
    import hashlib
    key = f"{user_id}#{attempt}".encode("utf-8") if attempt else str(user_id).encode("utf-8")
    return "MI" + hashlib.blake2b(key, salt=b"micall-inv", digest_size=4).hexdigest().upper()


_FORGET_RECENCY_FLOOR = 0.6   # 新近最多影响 ±40%：让「老而重要」压过「新而琐碎」（importance 主导、新近只宽限）


def _forget_score(importance: float | None, emotion_weight: float | None, recency_norm: float) -> float:
    """遗忘打分（越低越先忘）= 重要性 × 情感权重 × 新近宽限(0.6~1.0)。recency_norm∈[0,1]（1=最新,0=最旧）。
    第一性原理：人脑记忆有限，会把流水账淡忘、留要紧事。新近只当宽限项，importance/emotion 主导——
    老而重要的(0.9)始终压过新而琐碎的(0.3)，记得准而非记得新。纯函数、与 pg_repository 同义、便于测试。"""
    imp = max(0.0, min(1.0, importance if importance is not None else 0.5))
    emo = max(0.0, emotion_weight if emotion_weight is not None else 1.0)
    rec = max(0.0, min(1.0, recency_norm))
    return imp * emo * (_FORGET_RECENCY_FLOOR + (1.0 - _FORGET_RECENCY_FLOOR) * rec)


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
        emotion_weight: float = 1.0, importance: float = 0.5,
        vector: list[float] | None = None,
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

    def prune_facts(self, user_id: str, character_id: str, *, cap: int = 600) -> int:
        """记忆遗忘（容量封顶）：当某 user×char 的事实超过 cap，按遗忘分(重要性×情感×新近)忘掉最不显著的，
        只留 cap 条最该记的。第一性原理：人脑记忆有限、会淡忘流水账、留要紧事——事实表才不会无界膨胀，
        向量索引/召回/存储长期可控。仅超容时才动、平时 no-op。返回删除条数。基类 no-op（子类按存储实现）。"""
        return 0

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

    @abstractmethod
    def list_user_voices(self, user_id: str) -> dict[str, str]:
        """该用户全部「角色→已选音色」映射（{character_id: voice_id}）。用于用户端音色页跨设备回显选中态。"""
        ...

    @abstractmethod
    def clear_user_voice(self, user_id: str, character_id: str) -> None:
        """清掉该用户对某角色的音色覆盖 → 通话回退角色出厂默认音色（用户端「原本音色」）。"""
        ...

    # ── 账号级收藏（跨设备同步）+ 真实热门（按通话数）──
    @abstractmethod
    def list_favorites(self, user_id: str) -> list[str]:
        """该用户收藏的 character_id 列表（账号级，跨设备一致）。"""
        ...

    @abstractmethod
    def set_favorite(self, user_id: str, character_id: str, on: bool) -> None:
        """收藏/取消收藏某角色（on=True 收藏，False 取消）。"""
        ...

    @abstractmethod
    def char_call_counts(self) -> dict[str, int]:
        """各角色累计通话数（character_id → 次数，全用户）。用于用户端「热门」真实排序。"""
        ...

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

    def update_password(self, user_id: str, password_hash: str) -> bool:
        """改密码。返回是否成功。"""
        return False

    def get_user(self, user_id: str) -> dict | None:
        """user_id → {user_id,email,display_name,remaining_seconds}；无则 None。"""
        return None

    def set_user_banned(self, user_id: str, banned: bool) -> None:
        """运营封禁/解封某用户。基类（游客）no-op。"""

    def is_banned(self, user_id: str) -> bool:
        """该用户是否被封禁（登录/通话据此拒绝）。基类默认 False。"""
        return False

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

    # ── 游客试用配额（按 IP 防刷）──
    def guest_trial_remaining(self, ip: str, trial_seconds: int) -> int:
        """该 IP 还剩多少试用秒（trial_seconds - 已用，钳到 ≥0）。刷新不重置。"""
        return trial_seconds

    def consume_guest_trial(self, ip: str, seconds: int) -> None:
        """该 IP 试用消耗累加 seconds。"""

    # ── 通话记录 / 账单（P3）──
    def add_call(self, user_id: str, character_id: str, scenario: str,
                 duration_seconds: int, ended_reason: str,
                 transcript: list[dict] | None = None) -> None:
        """通话结束写一条记录（前端「通话历史」数据源）。transcript=本通对话逐句（[{role,content}]），
        供后台查看对话内容；None/空=不留存（隐私关时）。"""

    def list_calls(self, user_id: str, *, limit: int = 30) -> list[dict]:
        """该用户最近通话，新→旧。每条 {id,character_id,scenario,duration_seconds,ended_reason,started_at}。
        不含被用户删除（hidden_by_user）的记录。"""
        return []

    def seconds_since_last_call(self, user_id: str, character_id: str) -> float | None:
        """距上次和「这个角色」通话过去了多少秒（无往次通话则 None）。给「间隔感」用：
        让 AI 能说「三天没找我啦」「刚挂了又想我啦」。本通话写库（add_call）发生在挂断后，
        故新通话开场算到的最近一条 = 上一次通话，正是我们要的间隔。"""
        return None

    def hide_calls(self, user_id: str, ids: list) -> int:
        """用户端删除（隐藏）通话记录（账号级，跨设备一致）；后台统计仍计入。返回隐藏条数。"""
        return 0

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

    def character_call_counts(self) -> dict:
        """每个角色的真实通话数 {character_id: count}。后台「角色」列表统计。"""
        return {}

    def scenario_call_counts(self) -> dict:
        """每个场景的真实通话数 {scenario: count}。后台首页「热门场景」。"""
        return {}

    def call_trends(self) -> dict:
        """通话量趋势（从 calls 真实聚合）：{today:[{day,v}], "7d":[...], "30d":[...]}。后台首页图表。"""
        return {"today": [], "7d": [], "30d": []}

    # ── 用量/成本埋点 ──
    def add_usage(self, user_id: str, node: str, units: int, cost_micros: int) -> None:
        """通话结束记一行某节点用量+成本（micros=微美元）。"""

    def cost_summary(self) -> dict:
        """后台成本看板：{today_micros,month_micros,by_node:{node:micros},per_hour_micros,per_100min_micros}。"""
        return {"today_micros": 0, "month_micros": 0, "by_node": {}, "per_hour_micros": 0, "per_100min_micros": 0}

    # ── 兑换码（P5：后台自定义码+份数，用户核销充值）──
    def create_redeem_code(self, code: str, seconds: int, max_uses: int = 1) -> tuple[bool, str]:
        """新建自定义兑换码（值 seconds、可用 max_uses 份）。码已存在返回 (False, 提示)。"""
        return False, "暂不支持"

    def redeem_code(self, user_id: str, code: str) -> tuple[bool, int, str]:
        """用户核销：码有效且未用完、本人未用过 → 入账 seconds + 记 redeem 流水。返回 (成功, 改后余额, 提示)。"""
        return False, 0, "暂不支持"

    def list_redeem_codes(self, *, limit: int = 200) -> list[dict]:
        """兑换码列表（后台）：{code,seconds,used_count,max_uses,created_at}。"""
        return []

    def delete_redeem_code(self, code: str) -> bool:
        """删除兑换码（连带其使用记录）。返回是否删除成功。已发出的时长不回收。"""
        return False

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

    # ── 邀请（拉新奖励）──
    def get_invite_code(self, user_id: str) -> str:
        """取（无则建）用户的唯一邀请码。"""
        return ""

    def apply_invite(self, invitee_id: str, code: str, reward_seconds: int) -> tuple[bool, str]:
        """被邀请人注册带码 → 双方各得 reward_seconds（记 invite_reward）。返回 (是否成功, 提示)。"""
        return False, ""

    def invite_stats(self, user_id: str) -> dict:
        """用户邀请概况：{code, invited, reward_seconds}。"""
        return {"code": "", "invited": 0, "reward_seconds": 0}

    def invite_overview(self) -> dict:
        """后台邀请 KPI：{total_invites, reward_minutes}（reward 为双方合计分钟）。"""
        return {"total_invites": 0, "reward_minutes": 0}

    def list_all_invites(self, *, limit: int = 200) -> list[dict]:
        """全站邀请记录（后台）：{inviter_email,invitee_email,reward_seconds,created_at}。"""
        return []


class InMemoryRepository(MemoryRepository):
    """字典实现。配了 Embedding 节点则按余弦相似召回（recall_vec），否则字符重叠近似（recall）。
    真实部署换 PgRepository（pgvector 余弦 + 持久化）。"""

    def __init__(self) -> None:
        # 每条事实：(text, emotion_weight, vector|None)
        self._facts: dict[tuple[str, str], list[tuple[str, float, list[float] | None, float]]] = {}  # (text, emotion_weight, vector, importance)
        self._profiles: dict[tuple[str, str], UserProfile] = {}
        self._voices: dict[tuple[str, str], str] = {}
        self._favorites: set[tuple[str, str]] = set()      # (user_id, character_id) 账号级收藏（跨设备同步）
        self._autonomous: dict[str, AutonomousState] = {}
        self._users: dict[str, dict] = {}                  # user_id → 账号
        self._email_idx: dict[str, str] = {}               # email(lower) → user_id
        self._sessions: dict[str, tuple[str, float]] = {}  # token → (user_id, expires_epoch)
        self._calls: list[dict] = []                       # 通话记录（含 user_id）
        self._ledger: list[dict] = []                      # 计费流水（含 user_id）
        self._guest_trials: dict[str, int] = {}            # ip → 已用试用秒
        self._orders: list[dict] = []                      # 充值订单（保留：支付接入时写入）
        self._redeem: dict[str, dict] = {}                 # code → 兑换码
        self._tickets: list[dict] = []                     # 工单（含 user_id）
        self._tid = 0                                      # 工单自增 id
        self._usage_log: list[dict] = []                   # 用量/成本埋点
        self._invite_by_user: dict[str, str] = {}          # user_id → 邀请码
        self._invite_owner: dict[str, str] = {}            # 邀请码 → user_id
        self._invite_uses: list[dict] = []                 # 邀请使用记录

    def add_fact(
        self, user_id: str, character_id: str, text: str, *,
        emotion_weight: float = 1.0, importance: float = 0.5,
        vector: list[float] | None = None,
    ) -> None:
        self._facts.setdefault((user_id, character_id), []).append((text, emotion_weight, vector, importance))

    def has_facts(self, user_id: str, character_id: str) -> bool:
        return bool(self._facts.get((user_id, character_id)))

    def prune_facts(self, user_id: str, character_id: str, *, cap: int = 600) -> int:
        key = (user_id, character_id)
        items = self._facts.get(key)
        if not items or cap <= 0 or len(items) <= cap:
            return 0
        n = len(items)
        # items 为追加序（旧→新）：i 越大越新 → recency_norm=i/(n-1)。留遗忘分最高的 cap 条。
        keep = set(sorted(range(n), key=lambda i: _forget_score(items[i][3], items[i][1], i / max(1, n - 1)),
                          reverse=True)[:cap])
        kept = [it for i, it in enumerate(items) if i in keep]   # 保留原追加序（召回的新近 tiebreaker 仍成立）
        self._facts[key] = kept
        return n - len(kept)

    def reset_memory(self, user_id: str, character_id: str) -> None:
        self._facts.pop((user_id, character_id), None)       # 事实层
        self._profiles.pop((user_id, character_id), None)    # 理解层（画像/关系/策略）

    def recall(self, user_id: str, character_id: str, query: str, *, top_k: int = 5) -> list[str]:
        items = self._facts.get((user_id, character_id), [])
        if not items:
            return []
        q = set(query)
        # 近似分 = 字符重叠 × 情感权重 × 重要性 × 新近(轻)。新近压到 0.8~1.0（原 1~2 会盖过相关度）：
        # 相关度/重要性主导，新近只当轻微 tiebreaker（与 pg_repository.recall 一致）→ 记得准而非记得新。
        scored = [
            (len(q & set(text)) * weight * imp * (0.8 + 0.2 * i / max(1, len(items))), text)
            for i, (text, weight, _v, imp) in enumerate(items)
        ]
        scored.sort(key=lambda s: s[0], reverse=True)
        return [text for score, text in scored[:top_k] if score > 0]

    def recall_vec(
        self, user_id: str, character_id: str, query_vector: list[float], *,
        query: str = "", top_k: int = 5,
    ) -> list[str]:
        items = self._facts.get((user_id, character_id), [])
        if not items or query_vector is None or len(query_vector) == 0:
            return self.recall(user_id, character_id, query, top_k=top_k)
        n = len(items)
        scored: list[tuple[float, str]] = []
        any_vec = False
        for i, (text, weight, vec, imp) in enumerate(items):
            if vec:
                any_vec = True
                # 余弦相似 × 情感权重 × 重要性 × 新近(0.8~1.0)。语义相关度/重要性主导，新近当一致的轻 tiebreaker
                # ——与关键词 recall 同口径(0.8~1.0)、与 pg_repository.recall_vec 同口径：语义近似时让【改口/新事实】
                # （如「我其实爱上咖啡了」）能压过旧表述翻出来，而不是被旧事实永久盖住。
                scored.append((_cosine(query_vector, vec) * weight * imp * (0.8 + 0.2 * i / max(1, n)), text))
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

    def list_user_voices(self, user_id: str) -> dict[str, str]:
        return {cid: vid for (uid, cid), vid in self._voices.items() if uid == user_id}

    def clear_user_voice(self, user_id: str, character_id: str) -> None:
        self._voices.pop((user_id, character_id), None)

    # ── 账号级收藏（跨设备同步）──
    def list_favorites(self, user_id: str) -> list[str]:
        return [cid for (uid, cid) in self._favorites if uid == user_id]

    def set_favorite(self, user_id: str, character_id: str, on: bool) -> None:
        key = (user_id, character_id)
        self._favorites.add(key) if on else self._favorites.discard(key)

    def char_call_counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for c in self._calls:
            cid = c.get("character_id")
            if cid:
                out[cid] = out.get(cid, 0) + 1
        return out

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

    def update_password(self, user_id, password_hash) -> bool:
        u = self._users.get(user_id)
        if not u:
            return False
        u["password_hash"] = password_hash
        return True

    def get_user(self, user_id):
        u = self._users.get(user_id)
        return {k: u[k] for k in ("user_id", "email", "display_name", "remaining_seconds")} if u else None

    def set_user_banned(self, user_id, banned) -> None:
        u = self._users.get(user_id)
        if u is not None:
            u["banned"] = bool(banned)

    def is_banned(self, user_id) -> bool:
        u = self._users.get(user_id)
        return bool(u and u.get("banned"))

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

    def guest_trial_remaining(self, ip, trial_seconds) -> int:
        return max(0, int(trial_seconds) - self._guest_trials.get(ip or "", 0))

    def consume_guest_trial(self, ip, seconds) -> None:
        self._guest_trials[ip or ""] = self._guest_trials.get(ip or "", 0) + max(0, int(seconds))

    def add_call(self, user_id, character_id, scenario, duration_seconds, ended_reason,
                 transcript=None) -> None:
        self._calls.append({
            "id": len(self._calls) + 1,
            "user_id": user_id, "character_id": character_id, "scenario": scenario or "",
            "duration_seconds": int(duration_seconds), "ended_reason": ended_reason or "ended",
            "started_at": _now_iso(), "hidden_by_user": False,
            "transcript": transcript or [],
        })

    def list_calls(self, user_id, *, limit=30) -> list[dict]:
        rows = [c for c in self._calls if c["user_id"] == user_id and not c.get("hidden_by_user")]
        rows.sort(key=lambda c: c["started_at"], reverse=True)
        return [{k: c[k] for k in ("id", "character_id", "scenario", "duration_seconds", "ended_reason", "started_at")}
                for c in rows[:limit]]

    def seconds_since_last_call(self, user_id, character_id) -> float | None:
        from datetime import datetime
        mine = [c["started_at"] for c in self._calls
                if c["user_id"] == user_id and c["character_id"] == character_id]
        if not mine:
            return None
        try:
            last = max(datetime.fromisoformat(s) for s in mine)
        except ValueError:
            return None
        now = datetime.now(last.tzinfo) if last.tzinfo else datetime.now()
        return max(0.0, (now - last).total_seconds())

    def hide_calls(self, user_id, ids) -> int:
        want = {int(i) for i in (ids or []) if isinstance(i, int) or str(i).lstrip("-").isdigit()}
        n = 0
        for c in self._calls:
            if c["user_id"] == user_id and c.get("id") in want and not c.get("hidden_by_user"):
                c["hidden_by_user"] = True
                n += 1
        return n

    def list_ledger(self, user_id, *, limit=30) -> list[dict]:
        rows = [b for b in self._ledger if b["user_id"] == user_id]
        return [{k: b[k] for k in ("delta_seconds", "reason", "created_at")} for b in rows[::-1][:limit]]

    # ── 后台看板聚合（内存）──
    def admin_stats(self) -> dict:
        today = _now_iso()[:10]
        # 与「用户管理」一致：只数真实注册用户（有邮箱），不含游客/无邮箱测试行。
        return {
            "total_users": sum(1 for u in self._users.values() if (u.get("email") or "").strip()),
            "calls_today": sum(1 for c in self._calls if c["started_at"][:10] == today),
            "total_minutes": sum(c["duration_seconds"] for c in self._calls) // 60,
            "month_revenue_cents": sum(o.get("amount_cents", 0) for o in self._orders if o.get("status") == "paid"),
        }

    def list_all_users(self, *, limit=200) -> list[dict]:
        out = []
        for u in self._users.values():
            if not (u.get("email") or "").strip():
                continue  # 只看真实注册用户：游客/无邮箱测试行不进后台
            mine = [c for c in self._calls if c["user_id"] == u["user_id"]]
            out.append({
                "user_id": u["user_id"], "email": u.get("email") or "",
                "remaining_seconds": u["remaining_seconds"], "created_at": u.get("created_at", ""),
                "total_calls": len(mine), "total_seconds": sum(c["duration_seconds"] for c in mine),
                "banned": bool(u.get("banned")),
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
            "transcript": c.get("transcript") or [],
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

    def character_call_counts(self) -> dict:
        from collections import Counter
        return dict(Counter(c["character_id"] for c in self._calls))

    def scenario_call_counts(self) -> dict:
        from collections import Counter
        return dict(Counter(c["scenario"] for c in self._calls if c.get("scenario")))

    def add_usage(self, user_id, node, units, cost_micros) -> None:
        self._usage_log.append({"user_id": user_id, "node": node, "units": int(units),
                                "cost_micros": int(cost_micros), "created_at": _now_iso()})

    def cost_summary(self) -> dict:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        today, month = now.date().isoformat(), now.strftime("%Y-%m")
        today_rows = [u for u in self._usage_log if u["created_at"][:10] == today]
        today_micros = sum(u["cost_micros"] for u in today_rows)
        month_micros = sum(u["cost_micros"] for u in self._usage_log if u["created_at"][:7] == month)
        by_node: dict = {}
        for u in today_rows:
            by_node[u["node"]] = by_node.get(u["node"], 0) + u["cost_micros"]
        mins_today = sum(c["duration_seconds"] for c in self._calls if c["started_at"][:10] == today) / 60
        return {
            "today_micros": today_micros, "month_micros": month_micros, "by_node": by_node,
            "per_hour_micros": round(today_micros / max(1, now.hour + 1)),
            "per_100min_micros": round(today_micros / (mins_today / 100)) if mins_today >= 1 else 0,
        }

    def call_trends(self) -> dict:
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        ds = []
        for c in self._calls:
            try:
                ds.append(datetime.fromisoformat(c["started_at"]))
            except (ValueError, TypeError):
                pass
        today = now.date()
        today_calls = [d for d in ds if d.date() == today]
        today_series = [{"day": f"{h}时", "v": sum(1 for d in today_calls if h <= d.hour < h + 4)}
                        for h in (0, 4, 8, 12, 16, 20)]
        d7 = [{"day": f"{(now - timedelta(days=i)).month}/{(now - timedelta(days=i)).day}",
               "v": sum(1 for d in ds if d.date() == (now - timedelta(days=i)).date())} for i in range(6, -1, -1)]
        d30 = []
        for w in range(3, -1, -1):
            s = (now - timedelta(days=(w + 1) * 7 - 1)).date()
            e = (now - timedelta(days=w * 7)).date()
            d30.append({"day": f"第{4 - w}周", "v": sum(1 for d in ds if s <= d.date() <= e)})
        return {"today": today_series, "7d": d7, "30d": d30}

    # ── 兑换码（内存）──
    def create_redeem_code(self, code, seconds, max_uses=1) -> tuple[bool, str]:
        code = (code or "").strip().upper()
        if not code:
            return False, "兑换码不能为空"
        if code in self._redeem:
            return False, "兑换码已存在"
        self._redeem[code] = {"code": code, "seconds": int(seconds), "max_uses": max(1, int(max_uses)),
                              "used_count": 0, "users": set(), "created_at": _now_iso()}
        return True, "ok"

    def redeem_code(self, user_id, code) -> tuple[bool, int, str]:
        rec = self._redeem.get((code or "").strip().upper())
        if not rec:
            return False, self.remaining_seconds(user_id), "兑换码无效"
        if user_id in rec["users"]:
            return False, self.remaining_seconds(user_id), "你已使用过该兑换码"
        if rec["used_count"] >= rec["max_uses"]:
            return False, self.remaining_seconds(user_id), "兑换码已用完"
        rec["users"].add(user_id)
        rec["used_count"] += 1
        bal = self.add_seconds(user_id, rec["seconds"], "redeem")
        return True, bal, f"成功充值 {rec['seconds'] // 60} 分钟"

    def list_redeem_codes(self, *, limit=200) -> list[dict]:
        rows = sorted(self._redeem.values(), key=lambda r: r["created_at"], reverse=True)[:limit]
        return [{"code": r["code"], "seconds": r["seconds"], "used_count": r["used_count"],
                 "max_uses": r["max_uses"], "created_at": r["created_at"]} for r in rows]

    def delete_redeem_code(self, code) -> bool:
        return self._redeem.pop((code or "").strip().upper(), None) is not None

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

    # ── 邀请（内存）──
    def get_invite_code(self, user_id) -> str:
        code = self._invite_by_user.get(user_id)
        if not code:
            # 确定性派生：重启/换实例也算出同一个码，不再「变来变去」。撞到别人的码就加盐重算。
            for attempt in range(4):
                cand = stable_invite_code(user_id, attempt)
                if cand not in self._invite_owner or self._invite_owner[cand] == user_id:
                    code = cand
                    break
            else:
                code = stable_invite_code(user_id)
            self._invite_by_user[user_id] = code
            self._invite_owner[code] = user_id
        return code

    def apply_invite(self, invitee_id, code, reward_seconds) -> tuple[bool, str]:
        owner = self._invite_owner.get((code or "").strip().upper())
        if not owner:
            return False, "邀请码无效"
        if owner == invitee_id:
            return False, "不能用自己的邀请码"
        if any(u["invitee_id"] == invitee_id for u in self._invite_uses):
            return False, "已使用过邀请码"
        self._invite_uses.append({"code": code, "inviter_id": owner, "invitee_id": invitee_id,
                                  "reward_seconds": reward_seconds, "created_at": _now_iso()})
        self.add_seconds(owner, reward_seconds, "invite_reward")
        self.add_seconds(invitee_id, reward_seconds, "invite_reward")
        return True, f"邀请成功，双方各得 {reward_seconds // 60} 分钟"

    def invite_stats(self, user_id) -> dict:
        uses = [u for u in self._invite_uses if u["inviter_id"] == user_id]
        return {"code": self.get_invite_code(user_id), "invited": len(uses),
                "reward_seconds": sum(u["reward_seconds"] for u in uses)}

    def list_all_invites(self, *, limit=200) -> list[dict]:
        email = {u["user_id"]: (u.get("email") or "") for u in self._users.values()}
        rows = sorted(self._invite_uses, key=lambda u: u["created_at"], reverse=True)[:limit]
        return [{"inviter_email": email.get(u["inviter_id"], ""), "invitee_email": email.get(u["invitee_id"], ""),
                 "reward_seconds": u["reward_seconds"], "created_at": u["created_at"]} for u in rows]

    def invite_overview(self) -> dict:
        total = len(self._invite_uses)
        return {"total_invites": total, "reward_minutes": sum(u["reward_seconds"] * 2 for u in self._invite_uses) // 60}
