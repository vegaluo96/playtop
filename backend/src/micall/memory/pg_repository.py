"""Postgres + pgvector 持久化仓储（docs/02 §3.1 / §6）。

实现与 InMemoryRepository 完全一致的同步接口，落库 Postgres：事实层（facts，pgvector 余弦）、
理解层（user_profile，JSONB）、用户自定义音色、角色自主状态。配了 database.dsn 即由工厂选用，
否则回退 InMemoryRepository（重启即丢）。schema 见 memory/schema.sql。

设计取舍：保持同步接口（不改全栈为 async），用连接池；实时召回是单条索引查询（~ms 级），
启动 launch 规模可接受；高并发再把召回挪到线程池/改 async（接口不变）。需 psycopg[binary,pool]。
"""
from __future__ import annotations

import dataclasses
import json
import logging
from pathlib import Path

from ..context.models import (
    AutonomousState, Hypothesis, Insight, Relationship, UserProfile,
)
from .repository import MemoryRepository

log = logging.getLogger("micall.pg")

try:
    import psycopg
    from psycopg_pool import ConnectionPool
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore
    ConnectionPool = None  # type: ignore

_SCHEMA = Path(__file__).with_name("schema.sql")


def _vec_literal(v: list[float] | None) -> str | None:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]" if v else None


def _profile_to_json(p: UserProfile) -> str:
    return json.dumps({
        "fact_profile": p.fact_profile,
        "personality_model": [dataclasses.asdict(i) for i in p.personality_model],
        "interaction_prefs": p.interaction_prefs,
        "open_hypotheses": [dataclasses.asdict(h) for h in p.open_hypotheses],
        "relationship": dataclasses.asdict(p.relationship),
    }, ensure_ascii=False)


def _profile_from_json(user_id: str, character_id: str, raw: dict, next_strategy: str) -> UserProfile:
    rel = raw.get("relationship") or {}
    return UserProfile(
        user_id=user_id, character_id=character_id,
        fact_profile=raw.get("fact_profile") or {},
        personality_model=[Insight(**i) for i in (raw.get("personality_model") or []) if isinstance(i, dict)],
        interaction_prefs=raw.get("interaction_prefs") or {},
        open_hypotheses=[Hypothesis(**h) for h in (raw.get("open_hypotheses") or []) if isinstance(h, dict)],
        relationship=Relationship(**{k: rel[k] for k in rel if k in Relationship.__dataclass_fields__}),
        next_strategy=next_strategy or "",
    )


class PgRepository(MemoryRepository):
    def __init__(self, dsn: str) -> None:
        if ConnectionPool is None:  # pragma: no cover
            raise RuntimeError("PgRepository 需要 psycopg：pip install 'psycopg[binary,pool]'")
        self.pool = ConnectionPool(dsn, min_size=1, max_size=8, kwargs={"autocommit": True})
        self.pool.wait(timeout=10)
        self._init_schema()

    def _init_schema(self) -> None:
        # 自动建表/扩展（开机即建，无需人工跑脚本）。autocommit 下逐句执行：
        # CREATE EXTENSION 可能因 app 角色非超级用户而失败（扩展已由 bootstrap 以超管建好），
        # 单句失败不影响后续建表。
        sql = _SCHEMA.read_text(encoding="utf-8")
        with self.pool.connection() as c:
            for stmt in (s.strip() for s in sql.split(";")):
                if not stmt or all(ln.lstrip().startswith("--") for ln in stmt.splitlines()):
                    continue
                try:
                    c.execute(stmt)
                except Exception as e:
                    log.warning("schema 段落跳过（多半是扩展权限，已由 bootstrap 建好）：%r", e)

    # ── 出厂角色 & 用户存在性（FK 前置）──
    def seed_characters(self, specs: dict[str, dict]) -> None:
        with self.pool.connection() as c:
            for cid, spec in specs.items():
                ident, voice = spec.get("identity", {}), spec.get("voice", {})
                c.execute(
                    """INSERT INTO characters (character_id, name, version, spec, voice_id, emotion_map)
                       VALUES (%s,%s,%s,%s::jsonb,%s,%s::jsonb)
                       ON CONFLICT (character_id) DO UPDATE SET
                         name=EXCLUDED.name, version=EXCLUDED.version, spec=EXCLUDED.spec,
                         voice_id=EXCLUDED.voice_id, emotion_map=EXCLUDED.emotion_map, updated_at=now()""",
                    (cid, ident.get("name", ""), str(ident.get("version", "1")),
                     json.dumps(spec, ensure_ascii=False), voice.get("voice_id", ""),
                     json.dumps(voice.get("emotion_map", {}), ensure_ascii=False)),
                )

    def ensure_user(self, user_id: str, *, email: str | None = None, gift_seconds: int = 0) -> None:
        with self.pool.connection() as c:
            c.execute(
                "INSERT INTO users (user_id, email, remaining_seconds) VALUES (%s,%s,%s) "
                "ON CONFLICT (user_id) DO NOTHING",
                (user_id, email, gift_seconds),
            )

    # ── 事实层 ──
    def add_fact(self, user_id, character_id, text, *, emotion_weight=1.0, vector=None) -> None:
        try:
            self.ensure_user(user_id)
            with self.pool.connection() as c:
                c.execute(
                    "INSERT INTO facts (user_id, character_id, text, embedding, emotion_weight) "
                    "VALUES (%s,%s,%s,%s::vector,%s)",
                    (user_id, character_id, text, _vec_literal(vector), emotion_weight),
                )
        except Exception as e:  # FK/维度不符/连接：离线写入失败不该影响通话
            log.warning("add_fact 失败（忽略）：%r", e)
            if vector is not None:  # 多半是向量维度与列不符 → 退而存无向量
                try:
                    with self.pool.connection() as c:
                        c.execute(
                            "INSERT INTO facts (user_id, character_id, text, emotion_weight) VALUES (%s,%s,%s,%s)",
                            (user_id, character_id, text, emotion_weight),
                        )
                except Exception:
                    pass

    def recall(self, user_id, character_id, query, *, top_k=5) -> list[str]:
        try:
            with self.pool.connection() as c:
                rows = c.execute(
                    "SELECT text FROM facts WHERE user_id=%s AND character_id=%s "
                    "ORDER BY created_at DESC LIMIT %s",
                    (user_id, character_id, top_k),
                ).fetchall()
            return [r[0] for r in rows]
        except Exception as e:
            log.warning("recall 失败：%r", e)
            return []

    def recall_vec(self, user_id, character_id, query_vector, *, query="", top_k=5) -> list[str]:
        if not query_vector:
            return self.recall(user_id, character_id, query, top_k=top_k)
        try:
            with self.pool.connection() as c:
                rows = c.execute(
                    "SELECT text FROM facts WHERE user_id=%s AND character_id=%s AND embedding IS NOT NULL "
                    "ORDER BY embedding <=> %s::vector LIMIT %s",
                    (user_id, character_id, _vec_literal(query_vector), top_k),
                ).fetchall()
            return [r[0] for r in rows] or self.recall(user_id, character_id, query, top_k=top_k)
        except Exception as e:
            log.warning("recall_vec 失败，退关键词：%r", e)
            return self.recall(user_id, character_id, query, top_k=top_k)

    def has_facts(self, user_id, character_id) -> bool:
        try:
            with self.pool.connection() as c:
                r = c.execute(
                    "SELECT EXISTS(SELECT 1 FROM facts WHERE user_id=%s AND character_id=%s)",
                    (user_id, character_id),
                ).fetchone()
            return bool(r and r[0])
        except Exception:
            return False

    def reset_memory(self, user_id, character_id) -> None:
        try:
            with self.pool.connection() as c:
                c.execute("DELETE FROM facts WHERE user_id=%s AND character_id=%s", (user_id, character_id))
                c.execute("DELETE FROM user_profile WHERE user_id=%s AND character_id=%s", (user_id, character_id))
        except Exception as e:
            log.warning("reset_memory 失败：%r", e)

    # ── 理解层 ──
    def get_profile(self, user_id, character_id) -> UserProfile:
        try:
            with self.pool.connection() as c:
                r = c.execute(
                    "SELECT profile, next_strategy FROM user_profile WHERE user_id=%s AND character_id=%s",
                    (user_id, character_id),
                ).fetchone()
            if r:
                raw = r[0] if isinstance(r[0], dict) else json.loads(r[0] or "{}")
                return _profile_from_json(user_id, character_id, raw, r[1])
        except Exception as e:
            log.warning("get_profile 失败：%r", e)
        return UserProfile(user_id=user_id, character_id=character_id)

    def save_profile(self, profile: UserProfile) -> None:
        try:
            self.ensure_user(profile.user_id)
            with self.pool.connection() as c:
                c.execute(
                    "INSERT INTO user_profile (user_id, character_id, profile, next_strategy, updated_at) "
                    "VALUES (%s,%s,%s::jsonb,%s,now()) "
                    "ON CONFLICT (user_id, character_id) DO UPDATE SET "
                    "profile=EXCLUDED.profile, next_strategy=EXCLUDED.next_strategy, updated_at=now()",
                    (profile.user_id, profile.character_id, _profile_to_json(profile), profile.next_strategy),
                )
        except Exception as e:
            log.warning("save_profile 失败：%r", e)

    # ── 用户自定义音色 ──
    def get_user_voice(self, user_id, character_id) -> str | None:
        try:
            with self.pool.connection() as c:
                r = c.execute(
                    "SELECT voice_id FROM user_voice WHERE user_id=%s AND character_id=%s",
                    (user_id, character_id),
                ).fetchone()
            return r[0] if r else None
        except Exception:
            return None

    def set_user_voice(self, user_id, character_id, voice_id, label="") -> None:
        try:
            self.ensure_user(user_id)
            with self.pool.connection() as c:
                c.execute(
                    "INSERT INTO user_voice (user_id, character_id, voice_id, label) VALUES (%s,%s,%s,%s) "
                    "ON CONFLICT (user_id, character_id) DO UPDATE SET voice_id=EXCLUDED.voice_id, label=EXCLUDED.label",
                    (user_id, character_id, voice_id, label),
                )
        except Exception as e:
            log.warning("set_user_voice 失败：%r", e)

    # ── 角色自主状态（存 characters.autonomous）──
    def get_autonomous(self, character_id) -> AutonomousState:
        try:
            with self.pool.connection() as c:
                r = c.execute("SELECT autonomous FROM characters WHERE character_id=%s", (character_id,)).fetchone()
            if r and r[0]:
                d = r[0] if isinstance(r[0], dict) else json.loads(r[0])
                return AutonomousState(**{k: d[k] for k in d if k in AutonomousState.__dataclass_fields__})
        except Exception:
            pass
        return AutonomousState()

    def save_autonomous(self, character_id, state: AutonomousState) -> None:
        try:
            with self.pool.connection() as c:
                c.execute(
                    "UPDATE characters SET autonomous=%s::jsonb WHERE character_id=%s",
                    (json.dumps(dataclasses.asdict(state), ensure_ascii=False), character_id),
                )
        except Exception as e:
            log.warning("save_autonomous 失败：%r", e)

    # ── 账号/会话/计费 ──
    def create_user(self, user_id, email, password_hash, *, display_name="", gift_seconds=0) -> bool:
        try:
            with self.pool.connection() as c, c.transaction():
                c.execute(
                    "INSERT INTO users (user_id, email, password_hash, display_name, remaining_seconds) "
                    "VALUES (%s,%s,%s,%s,%s)",
                    (user_id, email, password_hash, display_name, max(0, int(gift_seconds))),
                )
                if gift_seconds:
                    c.execute(
                        "INSERT INTO billing_ledger (user_id, delta_seconds, reason) VALUES (%s,%s,'register_gift')",
                        (user_id, int(gift_seconds)),
                    )
            return True
        except psycopg.errors.UniqueViolation:
            return False
        except Exception as e:
            log.warning("create_user 失败：%r", e)
            return False

    def auth_user(self, email):
        try:
            with self.pool.connection() as c:
                r = c.execute(
                    "SELECT user_id, password_hash FROM users WHERE lower(email)=lower(%s)", (email,)
                ).fetchone()
            return (r[0], r[1]) if r else None
        except Exception:
            return None

    def get_user(self, user_id):
        try:
            with self.pool.connection() as c:
                r = c.execute(
                    "SELECT user_id, email, display_name, remaining_seconds FROM users WHERE user_id=%s",
                    (user_id,),
                ).fetchone()
            return {"user_id": r[0], "email": r[1], "display_name": r[2], "remaining_seconds": r[3]} if r else None
        except Exception:
            return None

    def create_session(self, token, user_id, ttl_seconds) -> None:
        try:
            with self.pool.connection() as c:
                c.execute(
                    "INSERT INTO sessions (token, user_id, expires_at) "
                    "VALUES (%s,%s, now() + make_interval(secs => %s))",
                    (token, user_id, int(ttl_seconds)),
                )
        except Exception as e:
            log.warning("create_session 失败：%r", e)

    def user_for_token(self, token):
        try:
            with self.pool.connection() as c:
                r = c.execute(
                    "SELECT user_id FROM sessions WHERE token=%s AND expires_at > now()", (token,)
                ).fetchone()
            return r[0] if r else None
        except Exception:
            return None

    def delete_session(self, token) -> None:
        try:
            with self.pool.connection() as c:
                c.execute("DELETE FROM sessions WHERE token=%s", (token,))
        except Exception:
            pass

    def remaining_seconds(self, user_id) -> int:
        try:
            with self.pool.connection() as c:
                r = c.execute("SELECT remaining_seconds FROM users WHERE user_id=%s", (user_id,)).fetchone()
            return int(r[0]) if r else 0
        except Exception:
            return 0

    def add_seconds(self, user_id, delta_seconds, reason) -> int:
        try:
            with self.pool.connection() as c, c.transaction():
                r = c.execute(
                    "UPDATE users SET remaining_seconds = GREATEST(0, remaining_seconds + %s) "
                    "WHERE user_id=%s RETURNING remaining_seconds",
                    (int(delta_seconds), user_id),
                ).fetchone()
                if r is None:
                    return 0
                c.execute(
                    "INSERT INTO billing_ledger (user_id, delta_seconds, reason) VALUES (%s,%s,%s)",
                    (user_id, int(delta_seconds), reason),
                )
            return int(r[0])
        except Exception as e:
            log.warning("add_seconds 失败：%r", e)
            return 0

    def close(self) -> None:
        try:
            self.pool.close()
        except Exception:
            pass
