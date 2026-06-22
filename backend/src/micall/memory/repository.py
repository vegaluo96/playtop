"""记忆仓储（docs/02 §3.1：事实层与理解层**物理分开**）。

  • 事实层：客观、只增、可检索（真实存 Postgres + pgvector）。
  • 理解层：主观、持续修正、有置信度（真实存 Postgres 结构化 JSONB）。
  • user_voice：§6.1 三级覆盖的"用户自定义"层载体。

接口纯抽象；InMemoryRepository 是零依赖实现，供骨架运行与测试。真实实现 PgRepository
用 asyncpg + pgvector（schema 见 memory/schema.sql）。
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod

from ..context.models import AutonomousState, UserProfile


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


class InMemoryRepository(MemoryRepository):
    """字典实现。配了 Embedding 节点则按余弦相似召回（recall_vec），否则字符重叠近似（recall）。
    真实部署换 PgRepository（pgvector 余弦 + 持久化）。"""

    def __init__(self) -> None:
        # 每条事实：(text, emotion_weight, vector|None)
        self._facts: dict[tuple[str, str], list[tuple[str, float, list[float] | None]]] = {}
        self._profiles: dict[tuple[str, str], UserProfile] = {}
        self._voices: dict[tuple[str, str], str] = {}
        self._autonomous: dict[str, AutonomousState] = {}

    def add_fact(
        self, user_id: str, character_id: str, text: str, *,
        emotion_weight: float = 1.0, vector: list[float] | None = None,
    ) -> None:
        self._facts.setdefault((user_id, character_id), []).append((text, emotion_weight, vector))

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
