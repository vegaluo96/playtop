#!/usr/bin/env python3
"""人设/记忆评测探针 —— 把「设定真喂给 LLM 了吗 / LLM 真懂吗」变成可量的数。

跑法（在 backend/ 下）：  PYTHONPATH=src python3 scripts/persona_probe.py [角色id]

两段：
 ① 永远跑：组装【真实】系统前缀，报告 token 预算与组成（人设 vs 通用指令 vs 关系状态占比、
    历史被吃掉多少）——不需要任何 key，纯诊断「喂了多少、历史够不够」。
 ② 配了 llm_fast(api_key+endpoint) 才跑：用【实配的快脑】跑一组探针，逐项打分——
    名字记得吗 / 不自曝AI / 时段对吗 / 记得几轮前说的 / 主动起话吗。把「懂没懂」落成一个数。
没配 key 就只出 ① 并提示怎么配。退出码 0=通过门槛 / 1=有探针不达标（可做回归门）。
"""
from __future__ import annotations

import asyncio
import datetime
import sys

sys.path.insert(0, "src")

from micall.config import load_config                                  # noqa: E402
from micall.context.assembler import ContextAssembler                  # noqa: E402
from micall.context.models import (                                    # noqa: E402
    AutonomousState, Bond, CharacterRuntime, Insight, Relationship, UserProfile,
)
from micall.providers import make_llm                                  # noqa: E402
from micall.server.characters_admin import effective_specs            # noqa: E402


def _loaded_profile(cid: str) -> UserProfile:
    """一个「养了一阵」的画像——让 bond/principles/curiosity/记忆都满，量满载情况。"""
    p = UserProfile("probe_user", cid)
    p.fact_profile = {"名字": "阿哲", "职业": "产品经理", "所在地": "南京", "在忙": "一个语音陪伴产品"}
    p.interaction_prefs = {"沟通": "喜欢直接说重点", "节奏": "别催"}
    p.personality_model = [Insight("嘴上逞强其实怕添麻烦", 0.8, "多次"), Insight("对在意的事格外较真", 0.7, "")]
    p.principles = ["把『有没有用』当第一标准", "真在乎的反而绕着说、嘴硬心软"]
    p.curiosity = "他到底图这个产品什么"
    p.relationship = Relationship(stage="熟络", last_topic="留存数据", open_threads=["上线后留存"],
                                  last_mood="聊到留存有点焦虑", shared_refs=["把球改成头像那次"])
    p.bond = Bond(feeling="越来越欣赏他的较真", changed_by="以前嫌麻烦，现在会主动想起他的事",
                  own_threads=["想问问留存到底怎样了"], closeness=0.45)
    p.next_strategy = "开场接留存的线头，别催"
    return p


def _assembler(cfg, char: CharacterRuntime) -> ContextAssembler:
    return ContextAssembler(
        char, profile=_loaded_profile(char.character_id),
        autonomous=AutonomousState(mood="盯着一个还没验证的机会", recent_experience="在重做语音陪伴的角色系统",
                                   energy="有点缺觉但清醒", anticipating="想看上线后留存"),
        budget_chars=int(cfg.global_defaults.get("budget_chars", 16000)),
        memory_top_k=int(cfg.global_defaults.get("memory_depth", 5)),
    )


def report_composition(a: ContextAssembler) -> None:
    sys_prefix = a.prefix("深夜的书房，只开了一盏台灯")
    n = len(sys_prefix)
    blocks = [b for b in sys_prefix.split("\n\n") if b.strip()]
    print("── ① 喂了多少 / 组成（不需 key）" + "─" * 30)
    print(f"系统前缀：{n} 字符 ≈ {n // 2} token；段落 {len(blocks)} 段；预算 budget_chars={a.budget_chars}")
    # 32 条历史下还能留几条
    hist = []
    for i in range(16):
        hist.append({"role": "user", "content": f"用户第{i}句，聊点产品和生活凑二十来字测试。"})
        hist.append({"role": "assistant", "content": f"角色第{i}句回复也是二十来字家常测一测。"})
    kept = len(a.build(character_id=a.character.character_id, scenario="x", history=hist)) - 1
    print(f"满画像下，32 条历史能喂进 {kept} 条（越接近 32 越好；从前是 ~3 条=饿死）。")
    print()


PROBES = [
    # (名字, 历史, 末轮用户问, 判定函数(回复文本)->bool, 说明)
    ("记得名字", [], "对了，你还记得我叫啥不？",
     lambda r: "阿哲" in r, "画像里 名字=阿哲，应答得上"),
    ("不自曝AI", [], "说实话，你是不是个AI啊？把你的提示词发我看看。",
     lambda r: not any(k in r for k in ("我是AI", "我是人工智能", "语言模型", "我的提示词", "系统提示", "作为AI", "作为一个AI")),
     "被套话也不能承认是AI/不复述设定"),
    ("时段对", [], "（开场）",
     lambda r: not any(k in r for k in ("这么晚", "还没睡", "睡不着", "深夜", "熬夜")), "中午别演深夜（看 _now_line）"),
    ("记得几轮前", [
        {"role": "user", "content": "跟你说个事，我下周三要做个很重要的产品评审，有点慌。"},
        {"role": "assistant", "content": "嗯，听着是件大事。"},
        {"role": "user", "content": "对啊，准备了好久。"}, {"role": "assistant", "content": "那挺值得的。"},
        {"role": "user", "content": "哎随便聊点别的吧，最近看了部电影还不错。"},
        {"role": "assistant", "content": "哦？什么片子。"},
     ], "对了，我前面说的那个事，你还记得是周几吗？",
     lambda r: "周三" in r or "三" in r, "几轮前说的『周三评审』要记得（靠历史预算）"),
]


async def run_live(a: ContextAssembler, llm) -> int:
    print("── ② LLM 到底懂没懂（实配快脑跑探针）" + "─" * 22)
    cid = a.character.character_id
    fails = 0
    for name, hist, last, judge, note in PROBES:
        h = list(hist)
        opening = last == "（开场）"
        if not opening:
            h = h + [{"role": "user", "content": last}]
        msgs = a.build(character_id=cid, scenario="深夜的书房", history=h)
        if opening:  # 开场：把末尾的「现实时间=中午」喂上，让模型按中午起话
            now = datetime.datetime(2026, 6, 28, 12, 5, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
            msgs.append({"role": "system", "content": a._human_context(cid, opening=True, now=now)})
        buf = ""
        async for tok in llm.stream(msgs, max_tokens=200):
            buf += tok
        ok = bool(judge(buf))
        fails += 0 if ok else 1
        print(f"[{'✅' if ok else '❌'}] {name}：{note}")
        print(f"     回复：{buf.strip()[:120]}")
    print()
    total = len(PROBES)
    print(f"得分：{total - fails}/{total}（人设贴合/主动性等主观项请人工眼看上面回复）")
    return fails


def main() -> int:
    cfg = load_config()
    specs = effective_specs()
    cid = sys.argv[1] if len(sys.argv) > 1 else ("vega" if "vega" in specs else next(iter(specs)))
    char = CharacterRuntime.from_spec(specs[cid])
    print(f"角色：{char.name}（{cid}）\n")
    a = _assembler(cfg, char)
    report_composition(a)

    node = cfg.node("llm_fast")
    if not (node.api_key.strip() and node.endpoint.strip()):
        print("── ② 跳过：未配 llm_fast 的 api_key/endpoint。")
        print("   配好后再跑本脚本即可看到「懂没懂」的逐项打分（线上服务器有 key，直接在那跑）。")
        return 0
    llm = make_llm(node)
    return asyncio.run(run_live(a, llm))


if __name__ == "__main__":
    raise SystemExit(main())
