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
import logging
from typing import Any, Sequence

from ..context.models import Hypothesis, Insight, UserProfile
from ..providers.base import LLMProvider

log = logging.getLogger("micall.understanding")

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
        "fact_profile": profile.fact_profile,
        "interaction_prefs": profile.interaction_prefs,
        "personality_model": [vars(i) for i in profile.personality_model],
        "open_hypotheses": [vars(h) for h in profile.open_hypotheses],
        "relationship": vars(profile.relationship),
        "bond": vars(profile.bond),
    }
    system = (
        "你是离线理解引擎。基于本次通话与现有画像，推断并修正你对这个人的理解。"
        "严格只输出一个 JSON 对象，字段："
        "new_facts(数组；每项可以是字符串，或 {text, importance} 对象，importance 取 0~1——"
        "TA 的重要事/在意的人事物/承诺给高分，闲聊寒暄给低分，便于日后优先想起要紧事)、"
        # fact_profile / interaction_prefs：过去 prompt 读了却没人写 → 永远空。现在补上，让角色跨通真记得你是谁、怎么待你舒服。
        "fact_profile(对象{键:值}；TA 的客观信息——名字/称呼、职业、所在地、在忙的事、重要的人、纪念日等，"
        "只记 TA【明确说过】的，键用简短中文；在现有 fact_profile 上增改、别删，没新信息就原样返回或省略)、"
        "interaction_prefs(对象{键:值}；怎么对待 TA 更舒服——如 喜欢被鼓励/不爱被催/喜欢直接说重点，只记有依据的)、"
        "insights([{insight,confidence,evidence}]，印证或推翻旧判断、暴露新模式)、"
        "hypotheses([{guess,confidence,next}]，带着假设进下次对话去验证)、"
        "relationship({stage,last_topic,open_threads,last_mood,shared_refs}，"
        "last_mood 用一句话概括 TA 这次的情绪基调与挂电话时的状态，供下次开场自然接住)、"
        "next_strategy(string，下次开场接哪个线头、验证哪个假设、哪些话题小心、怎么回应)、"
        # bond：从【角色本人】视角看这段关系——填补「角色不生长」的洞（双向身份）。
        "bond(对象{feeling, changed_by, own_threads, closeness_delta}；这是从【角色本人】视角看你们的关系，不是用户的——"
        "feeling=角色现在对 TA 的真实感觉/感情（信任/心疼/被打动/想护着/觉得有意思…，按角色性格来）、"
        "changed_by=认识 TA 让角色【自己】有了什么变化、"
        "own_threads=角色【自己这一侧】惦记着下次想跟 TA 说/做/问的事（角色的小心思/议程，1-3 条）、"
        "closeness_delta=亲近度变化 -0.2~0.2（聊得走心就+，被冒犯/疏远就-）；"
        "【严格贴角色人设】——冷淡/高冷角色别写得热络交心，关系还浅别写深情，没真实进展就别硬涨、留空即可)。"
        "【铁律】只记录本次通话里【明确出现过】的信息：不要把推测/脑补/'可能'当成事实写进 "
        "new_facts 或 last_topic——拿不准的一律放进 hypotheses（带 confidence）。"
        "绝不要虚构'谈过合作/约定过/一起做过/答应过'之类对话里没真实发生的共同经历或承诺。"
        "证据不足就少写、宁缺毋滥；没有可靠新信息时 new_facts 可为空数组。"
    )
    user = f"现有画像：{json.dumps(existing, ensure_ascii=False)}\n\n本次通话：\n{transcript}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_profile_update(raw: str) -> dict[str, Any]:
    """从 LLM 输出容错地抠出 JSON 对象（可能被前后文/代码围栏包裹）。失败返回空 dict。
    用 raw_decode 从第一个 `{` 起解析第一个完整对象、自动忽略其后的尾随文本——比 index..rindex 截取更稳：
    旧法遇到正文里出现 `}`（如「(注：…})」）或输出了多个对象，就会把标点/多余内容一起截进来 → 解析失败。"""
    if not raw:
        return {}
    decoder = json.JSONDecoder()
    idx = raw.find("{")
    while idx != -1:
        try:
            obj, _ = decoder.raw_decode(raw, idx)
        except (ValueError, json.JSONDecodeError):
            idx = raw.find("{", idx + 1)   # 这个 { 不是合法对象起点（多半在正文里）→ 试下一个
            continue
        return obj if isinstance(obj, dict) else {}
    return {}


def _fact_text_importance(f: Any, default: float = 0.5) -> tuple[str, float]:
    """归一化一条 new_facts：可能是字符串，或 {text, importance}。返回 (text, importance∈[0,1])。
    无效 → ("", default)。importance 容错钳到 [0,1]，缺省 default。"""
    if isinstance(f, str):
        return f.strip(), default
    if isinstance(f, dict):
        text = str(f.get("text", "")).strip()
        try:
            imp = float(f.get("importance", default))
        except (TypeError, ValueError):
            imp = default
        return text, max(0.0, min(1.0, imp))
    return "", default


_MAX_INSIGHTS = 20  # 画像洞察上限：无限堆叠会把人设块撑爆、稀释模型注意力 → 跨通话越聊越笨。


def _merge_kv(dst: dict[str, Any], src: Any, *, cap: int) -> None:
    """把 LLM 产出的 {键:值} 增改进 dst（不删旧、键值裁剪去空、防膨胀只留最近 cap 条）。"""
    if not isinstance(src, dict):
        return
    for k, v in src.items():
        ks, vs = str(k).strip()[:20], str(v).strip()[:100]
        if ks and vs:
            dst[ks] = vs
    if len(dst) > cap:
        for k in list(dst.keys())[:-cap]:
            del dst[k]


def merge_profile(profile: UserProfile, update: dict[str, Any]) -> UserProfile:
    """把模型产出合并进画像：洞察去重累积（同条更新置信度，不重复堆叠）、假设替换、关系/策略更新。"""
    # 客观事实 + 相处偏好：过去读了没人写的两个死字段，现在增改落库（跨通记得你是谁、怎么待你）。
    _merge_kv(profile.fact_profile, update.get("fact_profile"), cap=30)
    _merge_kv(profile.interaction_prefs, update.get("interaction_prefs"), cap=20)
    for ins in update.get("insights", []) or []:
        if isinstance(ins, dict) and ins.get("insight"):
            text = str(ins["insight"])
            conf = float(ins.get("confidence", 0.5))
            evid = str(ins.get("evidence", ""))
            existing = next((i for i in profile.personality_model if i.insight == text), None)
            if existing:  # 同一洞察已有 → 更新置信度/证据，不重复堆叠
                existing.confidence = conf
                if evid:
                    existing.evidence = evid
            else:
                profile.personality_model.append(Insight(insight=text, confidence=conf, evidence=evid))
    if len(profile.personality_model) > _MAX_INSIGHTS:  # 只留最近 N 条，防画像无限膨胀
        profile.personality_model = profile.personality_model[-_MAX_INSIGHTS:]
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
        r.last_mood = rel.get("last_mood", r.last_mood)
        if rel.get("open_threads"):
            r.open_threads = list(rel["open_threads"])
        if rel.get("shared_refs"):
            r.shared_refs = list(rel["shared_refs"])
    if update.get("next_strategy"):
        profile.next_strategy = str(update["next_strategy"])
    # 角色侧关系内在状态（双向身份）：随每通演化——感情/被改变/角色自己的议程/亲近度。
    bnd = update.get("bond")
    if isinstance(bnd, dict):
        if str(bnd.get("feeling", "")).strip():
            profile.bond.feeling = str(bnd["feeling"]).strip()[:300]
        if str(bnd.get("changed_by", "")).strip():
            profile.bond.changed_by = str(bnd["changed_by"]).strip()[:300]
        ot = bnd.get("own_threads")
        if isinstance(ot, list) and ot:
            profile.bond.own_threads = [str(t).strip()[:80] for t in ot if str(t).strip()][:6]
        try:
            d = float(bnd.get("closeness_delta", 0) or 0)
            profile.bond.closeness = round(max(0.0, min(1.0, profile.bond.closeness + max(-0.3, min(0.3, d)))), 3)
        except (TypeError, ValueError):
            pass
    return profile


class UnderstandingEngine:
    def __init__(self, llm: LLMProvider, repo: Any, *, max_tokens: int = 1024, embedder=None) -> None:
        self.llm = llm
        self.repo = repo
        self.max_tokens = max_tokens
        self.embedder = embedder  # 配了 Embedding 节点：事实入库时一并向量化（供余弦召回）

    async def _run_llm(self, messages: list[Message]) -> str:
        chunks: list[str] = []
        async for tok in self.llm.stream(messages, max_tokens=self.max_tokens):
            chunks.append(tok)
        return "".join(chunks)

    async def _vectors(self, texts: list[str]) -> list[list[float] | None]:
        """批量向量化事实（慢链路，离线跑，延迟无所谓）。未配 Embedding/失败 → 全 None（退关键词召回）。"""
        if self.embedder is None or not texts:
            return [None] * len(texts)
        try:
            vecs = await self.embedder.embed(texts)
            if len(vecs) == len(texts):
                return vecs  # type: ignore[return-value]
            log.warning("embedding 返回数(%d)与事实数(%d)不符，退关键词召回", len(vecs), len(texts))
        except Exception as e:  # 网络/鉴权/模型名：离线失败不影响任何实时路径。
            log.warning("事实向量化失败，退关键词召回：%r", e)
        return [None] * len(texts)

    async def process_call(
        self, user_id: str, character_id: str, history: Sequence[Message]
    ) -> UserProfile:
        """通话结束后跑一遍：写事实层（含向量化）+ 更新理解层。返回更新后的画像。"""
        # 1. 理解层（推断与修正）—— 先跑慢脑，顺带拿到模型抽取的 new_facts。
        profile = self.repo.get_profile(user_id, character_id)
        raw = await self._run_llm(build_understanding_prompt(profile, history))
        update = parse_profile_update(raw)

        # 2. 事实层（只增）：用户原话（默认重要性）+ 模型抽取的新事实（可带 importance），
        #    去重保序后批量向量化入库。重要性进检索打分，让日后优先想起要紧事（Generative Agents importance 维）。
        scored_facts: list[tuple[str, float]] = [(t, 0.5) for t in extract_facts(history)]  # 原话默认 0.5
        for f in update.get("new_facts", []) or []:
            text, imp = _fact_text_importance(f)
            if text:
                scored_facts.append((text, imp))
        seen: dict[str, float] = {}
        for text, imp in scored_facts:  # 去重保序：同一句保留较高的重要性
            seen[text] = max(seen.get(text, 0.0), imp)
        uniq = list(seen.keys())
        vectors = await self._vectors(uniq)
        for text, vec in zip(uniq, vectors):
            self.repo.add_fact(user_id, character_id, text, importance=seen[text], vector=vec)

        merged = merge_profile(profile, update)
        # 启发式兜底：从本通用户话里抽客观事实（名字/在做/喜欢…）补进 fact_profile，
        # 即使慢脑漏抽也有确定性底座，让跨通「记得你」不落空。不覆盖慢脑更精确的同名值。
        from ..context.assembler import _extract_user_facts
        for m in history:
            if m.get("role") == "user":
                for k, v in _extract_user_facts(m.get("content", "")).items():
                    merged.fact_profile.setdefault(k, v)
        self.repo.save_profile(merged)
        return merged
