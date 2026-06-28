"""记忆/人格数据模型（docs/02 §3.2 理解层 + §4.1 自主状态 + 铁律7 角色/用户分离）。

铁律7：角色定义（出厂，全用户共享）与用户关系（per-user，挂 character_id）严格分离。
  • CharacterRuntime —— 出厂角色（从资产管线 spec 提取，所有用户共享）。
  • UserProfile      —— per-user × per-character 的关系/画像（运行时生长）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ───────────────────────── 出厂角色（共享，只读）─────────────────────────
@dataclass
class CharacterRuntime:
    character_id: str
    name: str
    persona: dict[str, Any] = field(default_factory=dict)  # 资产 spec 的 persona 块
    identity: dict[str, Any] = field(default_factory=dict)  # 资产 spec 的 identity 块（性别/年龄/外貌/生日…）
    voice_id: str = ""
    emotion_map: dict[str, str] = field(default_factory=dict)  # tag → MiniMax emotion
    runtime_overrides: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_spec(cls, spec: dict[str, Any]) -> "CharacterRuntime":
        """从资产管线角色 spec（docs/01）提取后端运行时所需字段。"""
        ident = spec.get("identity", {})
        voice = spec.get("voice", {})
        return cls(
            character_id=ident.get("character_id", ""),
            name=ident.get("name", ""),
            persona=spec.get("persona", {}),
            identity=ident,  # 整块带上：让 AI 知道自己的性别/年龄/外貌/国籍/生日（否则被问就不知道）
            voice_id=voice.get("voice_id", ""),
            emotion_map=voice.get("emotion_map", {}),
            runtime_overrides=spec.get("runtime_overrides", {}) or {},
        )


# ───────────────────── 理解层：用户画像（§3.2，per-user×per-char）─────────────────
@dataclass
class Insight:
    """对「这个人是谁」的一条洞察：带置信度+证据，确定的可表现、猜测的要试探。"""

    insight: str
    confidence: float = 0.5
    evidence: str = ""


@dataclass
class Hypothesis:
    """待验证假设 —— 让画像主动生长的引擎（"变懂的加速度"）。"""

    guess: str
    confidence: float = 0.3
    next: str = ""


@dataclass
class Relationship:
    stage: str = "初识"          # 初识 → 熟络 → …（慢演进）
    last_topic: str = ""
    open_threads: list[str] = field(default_factory=list)  # 留的线头，下次开场可接
    last_call_at: str = ""
    last_mood: str = ""          # 上次通话的情绪基调（如"聊到工作压力，挂电话时闷闷的"）→ 下次开场能接住
    shared_refs: list[str] = field(default_factory=list)   # 共享的梗（"猫叫团子"）


@dataclass
class Bond:
    """角色【自己这一侧】对这段关系的内在状态——与 UserProfile(用户侧) 对称、会随相处演化。
    填补「角色不生长」的洞（双向身份）：让 TA 不只是「懂你」，而是「因为认识你而长出了对你的感情、
    被你改变、有自己惦记着要跟你说/做的事」。per-user×char，挂在 UserProfile 上。"""

    feeling: str = ""        # 现在对 TA 的感觉/感情（越来越信任 / 有点心疼 / 被 TA 的认真打动）
    changed_by: str = ""     # 这段相处把「我」改变了什么（以前嫌麻烦，现在会主动想起 TA 的事）
    own_threads: list[str] = field(default_factory=list)  # 「我」这侧惦记着想跟 TA 说/做/问的事（角色自己的议程，跨通连续）
    closeness: float = 0.0   # 角色 POV 的亲近度 0..1（慢慢长，给「关系在加深」一个连续量）


@dataclass
class UserProfile:
    user_id: str
    character_id: str
    fact_profile: dict[str, Any] = field(default_factory=dict)        # 客观信息
    personality_model: list[Insight] = field(default_factory=list)   # "懂"的本体
    interaction_prefs: dict[str, Any] = field(default_factory=dict)  # 该怎么对待 TA
    open_hypotheses: list[Hypothesis] = field(default_factory=list)  # 待验证假设
    relationship: Relationship = field(default_factory=Relationship)
    bond: "Bond" = field(default_factory=lambda: Bond())  # 角色这一侧的关系内在状态（双向身份，会演化）
    next_strategy: str = ""  # 理解引擎产出的「本轮对话策略」（§3.3 → §2.3 注入）


# ───────────────────── 尺度四：角色自主状态（§4.1，独立于用户）─────────────────
@dataclass
class AutonomousState:
    """和用户画像平级、完全独立 —— 它不为服务用户存在。让 TA 今天可能有点累/话多/心不在焉。"""

    mood: str = ""               # 当前心情
    recent_experience: str = ""  # 最近"在经历"的事（离线时间推进生成，§4.2）
    energy: str = ""             # 精力（满血 / 还行 / 有点累——真人不是恒定一档）
    anticipating: str = ""       # 在期待/惦记的一件小事（让"她有自己的盼头"，真人感）
