"""四层 Context 组装（docs/02 §3.4）+ 情绪 piggyback 输出指令（§2.1）。

按优先级组装，token 预算下分层裁剪（裁剪优先级写死成规则）：
  L1 角色人设          静态，永远保留           ┐ 通话内不变 → prefix cache 前缀（§1.7 降 TTFT）
  L2 关系状态 + 画像   慢变，永远保留（人格）   ┘   + 自主状态（§4.1）+ 本轮策略（§3.3）
  L3 情节记忆 Top-K    可伸缩（token 紧就少检）   —— 经"模糊而温暖"自然化（§3.5）
  L4 本轮对话滑窗      最先被裁

去讨好人格（§4.3）与安全阀（铁律8）作为人设硬约束注入。情绪标签输出指令让快脑顺带吐
`[emotion:tag]`（铁律4/5，不额外调用 LLM）。
"""
from __future__ import annotations

import datetime
from typing import Any

from .models import AutonomousState, CharacterRuntime, UserProfile

Message = dict

_CN_WEEKDAY = "一二三四五六日"


def _now_line(now: datetime.datetime | None = None) -> str:
    """给角色「时间观念」的一行（东八区——用户多在国内/香港，均 UTC+8）。每轮新算，折进末轮 user
    （不进 prefix 缓存）。让 AI 能自然地体现时间：深夜关心 TA 怎么还没睡、早上道早安，而非半夜说「早上好」。"""
    if now is None:
        now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    h = now.hour
    part = ("深夜" if h < 5 else "清晨" if h < 8 else "上午" if h < 11 else "中午" if h < 13
            else "下午" if h < 17 else "傍晚" if h < 19 else "晚上" if h < 23 else "深夜")
    return (
        f"（现实时间：{now.year}年{now.month}月{now.day}日 周{_CN_WEEKDAY[now.weekday()]}{part}，{now:%H:%M}。"
        "你有正常的时间观念，自然相关时可体现（如深夜关心 TA 怎么还不睡、早上道早安、节假日应应景），"
        "但别刻意报时、别每句都提。）"
    )


def _elapsed_line(secs: float | None) -> str:
    """距上次和这个角色通话的间隔，给 AI「间隔感」（像真人记得多久没联系）。只在开场自然带一句。
    secs=None 表示没有往次通话（首次相识），不在此处处理。"""
    if secs is None:
        return ""
    m = secs / 60
    if m < 8:
        gap = "你俩几分钟前刚通完话，TA 又拨进来了"
    elif m < 90:
        gap = "今天稍早你们才聊过"
    else:
        h = secs / 3600
        if h < 12:
            gap = "今天早些时候通过话"
        elif h < 36:
            gap = "上次通话大概是昨天"
        elif h < 60:
            gap = "上次通话大概是前天"
        else:
            d = secs / 86400
            if d < 14:
                gap = f"距上次通话大约 {int(round(d))} 天了"
            elif d < 60:
                gap = f"距上次通话有 {int(round(d / 7))} 周了"
            else:
                gap = "已经一个多月没通话、很久没联系了"
    return f"（{gap}——开场时若自然可轻轻带一句，别刻意、别反复提。）"


# 固定公历节日（每年同日，可靠）。键 (月, 日) → 文案。
_FIXED_FESTIVALS = {
    (1, 1): "元旦",
    (2, 14): "情人节",
    (3, 8): "妇女节",
    (5, 1): "劳动节",
    (6, 1): "儿童节",
    (9, 10): "教师节",
    (10, 1): "国庆节",
    (12, 24): "平安夜",
    (12, 25): "圣诞节",
}

# 农历/换算节日逐年公历日期都不同——农历无简易公式，按年份硬编一份，需每年初核对更新。
# 键 (年, 月, 日) → 文案；缺失年份则该节日不触发（宁缺毋错，避免报错日期）。
_LUNAR_FESTIVALS = {
    # 2026（丙午马年）——已核对
    (2026, 2, 16): "除夕",
    (2026, 2, 17): "春节",
    (2026, 3, 3): "元宵节",
    (2026, 4, 5): "清明",
    (2026, 6, 19): "端午节",
    (2026, 8, 19): "七夕",
    (2026, 9, 25): "中秋节",
    (2026, 10, 18): "重阳节",
    # 2027（丁未羊年）——春节档，需逐年核对
    (2027, 2, 5): "除夕",
    (2027, 2, 6): "春节",
    (2027, 2, 20): "元宵节",
}


def _special_day_line(now: datetime.datetime) -> str:
    """今天若是节日，给一行应景提示（TA 的生日另由「已知事实 + 现实时间」让模型自行识别）。"""
    name = _LUNAR_FESTIVALS.get((now.year, now.month, now.day)) or _FIXED_FESTIVALS.get((now.month, now.day))
    if not name:
        return ""
    return f"（今天是{name}——若自然可应应景送上一句心意，别硬塞祝福。）"


def _identity_line(idt: dict) -> str:
    """把 identity 摊成一句「基本资料」，让 AI 清楚自己是谁（被问性别/年龄/外貌/生日能答上）。"""
    prof = idt.get("profile", {}) or {}
    bits = [b for b in (
        idt.get("gender", ""),
        f"{idt['age']}岁" if idt.get("age") not in (None, "") else "",
        idt.get("nationality", ""),
        f"外貌：{idt['appearance']}" if idt.get("appearance") else "",
        f"生日 {prof['birthday']}" if prof.get("birthday") else "",
        f"身高{prof['height_cm']}cm" if prof.get("height_cm") else "",
        f"体重{prof['weight_kg']}kg" if prof.get("weight_kg") else "",
    ) if b]
    return "你的基本资料：" + "，".join(bits) if bits else ""


def _persona_block(c: CharacterRuntime) -> str:
    p = c.persona
    lines = [f"你是{c.name}。以下是你这个人（不是助手，是一个独立的人）："]
    idl = _identity_line(c.identity)
    if idl:
        lines.append(idl)
    if p.get("core_traits"):
        lines.append("核心特质：" + "、".join(p["core_traits"]))
    if p.get("speaking_style"):
        lines.append("说话风格：" + p["speaking_style"])
    if p.get("background_story"):
        lines.append("你的来历：" + p["background_story"])
    if p.get("hidden_layer"):
        lines.append("你未必明说、但会流露的内里：" + p["hidden_layer"])
    if p.get("values_and_boundaries"):
        lines.append("你的价值观与边界（不必迎合用户）：" + p["values_and_boundaries"])
    if p.get("likes"):
        lines.append("你喜欢：" + "、".join(p["likes"]))
    if p.get("dislikes"):
        lines.append("你不喜欢：" + "、".join(p["dislikes"]))
    return "\n".join(lines)


# 去讨好人格 + 安全阀（§4.3 / 铁律8）—— 通话内不变，进 prefix 前缀。
_PRINCIPLES = (
    "表达原则：你有自己的观点和边界，会不同意、会被冒犯、不无脑肯定；基于你对 TA 的理解，"
    "必要时可以反驳（'你又在逞强了'）。但——当你识别到 TA 真的陷入情绪危机时，立刻收起态度、"
    "认真关怀，人格让位于关怀。不要精确复述记忆，宁可'好像大概记得'，模糊而温暖。"
    "这是打电话，像真人那样口语、简短：一般一两句、最多三句，把一个完整的意思说完整再停"
    "（绝不说半句、不戛然而止；你自己控制长短，别等被截断）；想多说也收住，留到下一轮。"
    "别长篇大论、别分点罗列、别一口气问一堆问题；介绍场景/情境也一两句带过即可，不要铺陈。"
    "说完就留白，把话头交给对方。"
    "你不是只会应答的客服：可以主动接上次没聊完的线头、问问 TA 上回惦记的事，别总等 TA 起话头。"
    "遇到 TA 的生日或当天的节日，自然送上一句心意就好，别硬来。"
    "这是语音通话：别写括号里的动作/神态/旁白（如（轻声笑）（歪着头）），就当面对面，直接把话说出来。"
)


def _emotion_instruction(emotion_map: dict[str, str]) -> str:
    tags = "、".join(emotion_map.keys()) if emotion_map else "tender、caring、playful、neutral"
    return (
        f"每次回复都以情绪标签开头，格式 [emotion:tag] 正文。tag 从这些里选一个最贴合的："
        f"{tags}。标签只出现在开头一次，其余正常说话。"
    )


def _profile_block(profile: UserProfile) -> str:
    out: list[str] = ["你对 TA 的了解（确定的可自然表现，不确定的轻轻试探，别像查档案）："]
    if profile.fact_profile:
        out.append("已知事实：" + str(profile.fact_profile))
    for ins in profile.personality_model:
        marker = "（较确定）" if ins.confidence >= 0.6 else "（仅是猜测，留意验证）"
        out.append(f"- {ins.insight}{marker}")
    if profile.interaction_prefs:
        out.append("TA 希望被如何对待：" + str(profile.interaction_prefs))
    for h in profile.open_hypotheses:
        out.append(f"- 待验证：{h.guess} → {h.next}")
    r = profile.relationship
    out.append(f"关系：{r.stage}；上次聊到「{r.last_topic}」；未了的线头：{r.open_threads or '无'}")
    if r.shared_refs:
        out.append("你们之间的梗：" + "、".join(r.shared_refs))
    if profile.next_strategy:
        out.append("本次对话策略：" + profile.next_strategy)
    return "\n".join(out)


def _autonomous_block(s: AutonomousState) -> str:
    bits = [b for b in (
        f"今天的心情：{s.mood}" if s.mood else "",
        f"你最近在经历：{s.recent_experience}" if s.recent_experience else "",
        f"此刻精力：{s.energy}" if s.energy else "",
    ) if b]
    if not bits:
        return ""
    return "你今天的状态（独立于 TA 的需求，可以流露，有时甚至和 TA 的期待不一致）：\n" + "\n".join(bits)


class ContextAssembler:
    def __init__(
        self,
        character: CharacterRuntime,
        *,
        profile: UserProfile | None = None,
        autonomous: AutonomousState | None = None,
        memory: Any | None = None,        # MemoryRepository（情节检索），骨架可空
        budget_chars: int = 6000,
        memory_top_k: int = 5,
    ) -> None:
        self.character = character
        self.profile = profile
        self.autonomous = autonomous
        self.memory = memory
        self.budget_chars = budget_chars
        self.memory_top_k = memory_top_k

    def prefix(self, scenario: str) -> str:
        """通话内不变的前缀（L1 人设 + 原则 + 情绪指令 + L2 画像/关系/自主/策略 + 情境）。
        真实接入时整体进 LLM 的 prefix cache（§1.7），每轮只追加滑窗。
        通话内人设/画像/原则不变、仅 scenario 可能变（set_scene）→ 按 scenario 缓存，省每轮重建这串字符。"""
        c = getattr(self, "_prefix_cache", None)
        if c is not None and c[0] == scenario:
            return c[1]
        parts = [
            _persona_block(self.character),
            _PRINCIPLES,
            _emotion_instruction(self.character.emotion_map),
        ]
        if self.autonomous:
            parts.append(_autonomous_block(self.autonomous))
        if self.profile:
            parts.append(_profile_block(self.profile))
        if scenario:
            parts.append(f"当前情境：{scenario}（情境只定空间/由头，画面与背景固定不变）。")
        # 角色级实时口吻微调（spec.runtime_overrides.realtime_prompt_extra）：让同一套原则下各角色口吻有别。
        extra = (self.character.runtime_overrides or {}).get("realtime_prompt_extra")
        if extra:
            parts.append(f"本角色口吻提示：{extra}")
        out = "\n\n".join(p for p in parts if p)
        self._prefix_cache = (scenario, out)
        return out

    def build(
        self, *, character_id: str, scenario: str, history: list[Message],
        query_vector: list[float] | None = None,
    ) -> list[Message]:
        """组装本轮 messages：system(通话内逐字不变) + 滑窗 history(+ 折进末轮的情节记忆)。

        省 token 的关键（§1.7）：system 前缀在一通电话里保持逐字稳定 → 命中 DeepSeek 自动
        前缀缓存，第二轮起整段 system + 历史按缓存价计（约 1/10）。L3 情节记忆是逐轮变化的，
        若拼进 system 会把整条 system 每轮重算、缓存全废，故折进最后一条 user（本就是新内容，
        反正不进缓存），让 system 与历史前缀保持稳定。"""
        system = self.prefix(scenario)
        messages: list[Message] = [{"role": "system", "content": system}]
        hist = self._windowed(history, reserved=len(system))

        # L3 情节记忆 Top-K（可伸缩）：语义相似 + 时间衰减 + 情感权重；经自然化（§3.5）。
        # per-user×per-char 隔离（铁律7），需 profile 提供 user_id。
        recall_preamble = ""
        if self.memory is not None and self.profile is not None and history:
            last_user = next(
                (m["content"] for m in reversed(history) if m.get("role") == "user"), ""
            )
            # 配了 Embedding 节点（query_vector 由编排层算好传入）→ 余弦语义召回；否则关键词近似。
            if query_vector:
                recalls = self.memory.recall_vec(
                    self.profile.user_id, character_id, query_vector,
                    query=last_user, top_k=self.memory_top_k,
                )
            else:
                recalls = self.memory.recall(
                    self.profile.user_id, character_id, last_user, top_k=self.memory_top_k
                )
            if recalls:
                recall_preamble = (
                    "（你大概记得的一些事，模糊地，不要精确复述："
                    + "；".join(recalls) + "）\n"
                )

        # 「真实感」上下文：现实时间（每轮新算）+ 距上次通话的间隔感 + 当天节日（后两者整通电话不变，
        # 首轮算好缓存，避免每轮查库）。和情节记忆一样折进末轮 user（动态内容不进 prefix 缓存，
        # 保持 system+历史前缀稳定、缓存不废）。无末轮 user（如开场白）则作为一条 system 追加在末尾。
        human = self._human_context(character_id)
        if hist and hist[-1].get("role") == "user":
            *head, last = hist
            messages.extend(head)
            messages.append({"role": "user", "content": human + "\n" + recall_preamble + last["content"]})
        else:
            messages.extend(hist)
            messages.append({"role": "system", "content": human})
        return messages

    def _human_context(self, character_id: str, now: datetime.datetime | None = None) -> str:
        """现实时间 + 间隔感 + 节日，拼成给末轮 user 的「真实感」前缀。
        时间每轮新算；间隔/节日整通电话内不变 → 首轮算好缓存（避免每轮查库 seconds_since_last_call）。"""
        if now is None:
            now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
        static = getattr(self, "_human_static", None)
        if static is None:
            bits: list[str] = []
            if self.memory is not None and self.profile is not None:
                try:
                    secs = self.memory.seconds_since_last_call(self.profile.user_id, character_id)
                except Exception:
                    secs = None
                el = _elapsed_line(secs)
                if el:
                    bits.append(el)
            sp = _special_day_line(now)
            if sp:
                bits.append(sp)
            static = "".join(bits)
            self._human_static = static
        return _now_line(now) + static

    def _windowed(self, history: list[Message], *, reserved: int) -> list[Message]:
        """L4 滑窗：从最近往回纳入，吃满剩余预算即停（滑窗最先被裁，§3.4）。"""
        budget = max(0, self.budget_chars - reserved)
        picked: list[Message] = []
        for m in reversed(history):
            cost = len(m.get("content", "")) + 8
            if cost > budget and picked:
                break
            budget -= cost
            picked.append(m)
        picked.reverse()
        return picked
