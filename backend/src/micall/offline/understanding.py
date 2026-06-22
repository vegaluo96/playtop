"""离线理解引擎（docs/02 §3.3）—— 通话结束触发的后台 worker，**不碰实时路径**。

用较强的慢脑模型（Qwen-Long，走 apiyi，延迟无所谓）做三件事：
  1. 抽取新事实 → 写事实层（含向量化存 pgvector）。
  2. 更新画像：把「本次对话 + 现有画像」喂模型，印证/推翻旧判断、暴露新模式、验证上次假设，
     产出更新画像 + 新假设（理解层是护城河，豆包不做）。
  3. 生成「下次怎么懂他」的对话策略 → 供下次通话 §2.3 注入。

纯逻辑 + 可注入 LLM，零外部依赖即可单测；stub LLM 走降级（只抽事实），注入返回 JSON 的
LLM 则走完整画像更新。真实部署由消息队列触发（§6 离线任务）。
"""
from __future__ import annotations

import json
from typing import Any, Sequence

from ..context.models import Hypothesis, Insight, UserProfile
from ..providers.base import LLMProvider

Message = dict


def extract_facts(history: Sequence[Message]) -> list[str]:
    """从对话抽取用户陈述作事实层原料（骨架用用户原话；真实由 LLM 结构化抽取补充）。"""
    out: list[str] = []
    for m in history:
        if m.get("role") == "user":
            t = (m.get("content") or "").strip()
            if t:
                out.append(t)
    return out


def build_understanding_prompt(profile: UserProfile, history: Sequence[Message]) -> list[Message]:
    transcript = "\n".join(f"{m.get('role')}: {m.get('content')}" for m in history)
    existing = {
        "personality_model": [vars(i) for i in profile.personality_model],
        "open_hypotheses": [vars(h) for h in profile.open_hypotheses],
        "relationship": vars(profile.relationship),
    }
    system = (
        "你是离线理解引擎。基于本次通话与现有画像，推断并修正你对这个人的理解。"
        "严格只输出一个 JSON 对象，字段："
        "new_facts(string[])、"
        "insights([{insight,confidence,evidence}]，印证或推翻旧判断、暴露新模式)、"
        "hypotheses([{guess,confidence,next}]，带着假设进下次对话去验证)、"
        "relationship({stage,last_topic,open_threads,shared_refs})、"
        "next_strategy(string，下次开场接哪个线头、验证哪个假设、哪些话题小心、怎么回应)。"
    )
    user = f"现有画像：{json.dumps(existing, ensure_ascii=False)}\n\n本次通话：\n{transcript}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_profile_update(raw: str) -> dict[str, Any]:
    """从 LLM 输出容错地抠出 JSON 对象（可能被前后文包裹）。失败返回空 dict。"""
    try:
        start = raw.index("{")
        end = raw.rindex("}") + 1
        obj = json.loads(raw[start:end])
        return obj if isinstance(obj, dict) else {}
    except (ValueError, json.JSONDecodeError):
        return {}


def merge_profile(profile: UserProfile, update: dict[str, Any]) -> UserProfile:
    """把模型产出合并进画像：洞察累积（可带置信度修正）、假设替换、关系/策略更新。"""
    for ins in update.get("insights", []) or []:
        if isinstance(ins, dict) and ins.get("insight"):
            profile.personality_model.append(
                Insight(
                    insight=str(ins["insight"]),
                    confidence=float(ins.get("confidence", 0.5)),
                    evidence=str(ins.get("evidence", "")),
                )
            )
    hyps = update.get("hypotheses")
    if hyps:
        profile.open_hypotheses = [
            Hypothesis(
                guess=str(h.get("guess", "")),
                confidence=float(h.get("confidence", 0.3)),
                next=str(h.get("next", "")),
            )
            for h in hyps
            if isinstance(h, dict) and h.get("guess")
        ]
    rel = update.get("relationship") or {}
    if isinstance(rel, dict) and rel:
        r = profile.relationship
        r.stage = rel.get("stage", r.stage)
        r.last_topic = rel.get("last_topic", r.last_topic)
        if rel.get("open_threads"):
            r.open_threads = list(rel["open_threads"])
        if rel.get("shared_refs"):
            r.shared_refs = list(rel["shared_refs"])
    if update.get("next_strategy"):
        profile.next_strategy = str(update["next_strategy"])
    return profile


class UnderstandingEngine:
    def __init__(self, llm: LLMProvider, repo: Any, *, max_tokens: int = 1024) -> None:
        self.llm = llm
        self.repo = repo
        self.max_tokens = max_tokens

    async def _run_llm(self, messages: list[Message]) -> str:
        chunks: list[str] = []
        async for tok in self.llm.stream(messages, max_tokens=self.max_tokens):
            chunks.append(tok)
        return "".join(chunks)

    async def process_call(
        self, user_id: str, character_id: str, history: Sequence[Message]
    ) -> UserProfile:
        """通话结束后跑一遍：写事实层 + 更新理解层。返回更新后的画像。"""
        # 1. 事实层（只增）
        for fact in extract_facts(history):
            self.repo.add_fact(user_id, character_id, fact)

        # 2. 理解层（推断与修正）
        profile = self.repo.get_profile(user_id, character_id)
        raw = await self._run_llm(build_understanding_prompt(profile, history))
        update = parse_profile_update(raw)
        for f in update.get("new_facts", []) or []:
            if isinstance(f, str) and f.strip():
                self.repo.add_fact(user_id, character_id, f.strip())
        merged = merge_profile(profile, update)
        self.repo.save_profile(merged)
        return merged
