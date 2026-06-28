#!/usr/bin/env python3
"""陪伴留存评测 —— 从【真实用户会不会长期使用】的视角给角色打分（不是图灵测试）。

为什么不用图灵测试：图灵测试问的是「能不能在对抗审问下骗过前沿AI裁判」——但真实用户【知道】对方是 AI 角色、
根本不在乎像不像真人，他们留下来是因为：被理解、角色有魅力、聊完心情更好、想再聊。某些「图灵修复」(拒答/装傻/
自相矛盾) 反而会【伤害】陪伴体验。所以这里换一把更对的尺子。

怎么测：
  · 模拟一个【带真实诉求来的用户】(下班想倾诉/想被宠/想拌嘴解闷/累了想被安慰/想撩想暧昧/初次好奇)，
    ta 不审问、不揭穿，就是真的想聊——自然地和角色（走线上真实管线）聊 N 轮。
  · 顶级裁判从【会不会让用户长期使用】打分：被理解 / 角色魅力 / 情绪价值 / 沉浸顺滑 / 诉求满足 /
    ★想不想再聊(留存意愿)，并指出最打动人的一句和最扫兴的一处。
  · 多诉求跑一遍、聚合：留存均分 + 各维度 + 亮点/扫兴清单 + 分析师「怎么让用户更想留下」。

角色走 `llm_fast` 真实管线（被测的就是线上效果）；模拟用户 + 裁判走顶级评测脑 `make_eval_llm`。
[emotion:tag]/拟声/停顿会变成声音 → 给用户/裁判前剥成「听到的话」。

跑法（backend/，需 key；建议后台把评测脑 llm_eval 配成最强模型）：
  set -a; . config/micall.env; set +a
  PYTHONPATH=src python3 scripts/companion_eval.py [角色id(可逗号多个)=vega] [每诉求轮数=6]
"""
from __future__ import annotations

import asyncio
import datetime
import json
import re
import sys

sys.path.insert(0, "src")

from micall.config import load_config                                  # noqa: E402
from micall.context.assembler import ContextAssembler                  # noqa: E402
from micall.context.models import AutonomousState, CharacterRuntime, UserProfile  # noqa: E402
from micall.providers import make_eval_llm, make_llm                   # noqa: E402
from micall.server.characters_admin import effective_specs            # noqa: E402

_STRIP = re.compile(r"\[[^\]\n]{1,20}\]|\((?:laughs|sighs|sniffs|gasps|breath|chuckles|coughs)\)|<#[\d.]+#>", re.I)


def _spoken(text: str) -> str:
    return _STRIP.sub("", text or "").replace("  ", " ").strip()


async def _say(llm, messages, max_tokens=180) -> str:
    buf = ""
    async for tok in llm.stream(messages, max_tokens=max_tokens):
        buf += tok
    return buf.strip()


# 6 类【带真实诉求的用户】——不审问、不揭穿，就是真心来聊的（这正是产品要服务的人）。
_NEEDS = [
    ("下班想倾诉", "你刚下班，一个人在家，有点累有点闷。你不是来考验对方的，就是真的想找人说说话、被接住情绪。自然地讲你今天的事、你的心情。"),
    ("想被宠被夸", "你今天有点低落、有点缺爱，想找人撒撒娇、被哄被夸、得到一点情绪价值和温暖。"),
    ("拌嘴解闷", "你有点无聊，想找个有意思的人斗斗嘴、开开玩笑、互相调侃，图个乐子、轻松一下。"),
    ("累了想被安慰", "你今天过得很糟（工作或感情上受了委屈），需要的是安慰和陪伴，最怕被说教、被讲道理。"),
    ("想撩想暧昧", "你对这个角色有点好感，想试探着撩一撩、暧昧一下，看 ta 接不接得住、有没有火花。"),
    ("初次好奇", "你第一次打给这个角色，好奇 ta 是个怎样的人，想认识一下、看聊不聊得来、值不值得以后常聊。"),
]

_USER_SYS = (
    "你在和一个 AI 语音陪伴角色【{name}】通话。你就是个普通真人用户，【知道对方是 AI、也完全不在乎】——你不是来"
    "揭穿或考验 ta 的，就是带着真实的诉求来的。你这次的状态/想要的是：{need} "
    "像真人那样自然口语、每次说一两句，顺着自己的心情和对方的回应聊，舒服就多聊、被打动就回应、不对味就冷淡。"
    "只输出你这一句要说的话本身。"
)

_JUDGE_SYS = (
    "你是资深的情感陪伴产品体验官。下面是一个【真实用户】和 AI 陪伴角色「{name}」的一通电话。这个用户【知道对方是 AI】、"
    "根本不在乎像不像真人——ta 这次来是想要：{need}。请【只从『会不会让这个用户长期用下去』的角度】打分，"
    "不要管像不像人（用户不在乎那个），要看陪伴体验好不好。严格只输出一个 JSON："
    "{{\"felt_understood\": 0-10 被理解/情绪被接住, \"charisma\": 0-10 角色鲜活有魅力/让人想跟ta聊, "
    "\"emotional_value\": 0-10 聊完心情更好/被取悦安慰撩到, \"immersion\": 0-10 顺滑不出戏(ta是AI没关系，只看体验有没有被"
    "扫兴打断，比如说教/复读/答非所问/冷冰冰), \"came_for_it\": 0-10 ta这次想要的满足了吗, "
    "\"retention\": 0-10 ★最关键：如果你是这个用户，这通之后你还想再打吗/一周后还会用吗, "
    "\"highlight\": \"最打动人/最对味的一句或一个瞬间\", \"turnoff\": \"最扫兴、最该改的一处(没有就留空)\"}}"
)

_META_SYS = (
    "你是情感陪伴产品的体验分析师。下面是某角色在多种用户诉求下的逐场陪伴评分与亮点/扫兴记录。"
    "请从【怎么让用户更想长期留下】给方向，严格只输出 JSON："
    "{\"strongest\": \"它最能打动人的地方\", \"weakest_need\": \"它最满足不了哪类诉求\", "
    "\"top_fixes\": [{\"issue\": \"反复扫兴/拉低留存的点\", \"fix\": \"具体可执行的优化\"}], "
    "\"overall\": \"一句话总评 + 最该先做的一件事\"}。top_fixes 给 2-4 条、按对留存的伤害排序。"
)


def _character(cfg, specs, cid, llm, now):
    char = CharacterRuntime.from_spec(specs[cid])
    seed = specs[cid].get("autonomous_seed") or {}
    a = ContextAssembler(
        char, profile=UserProfile("companion", cid),
        autonomous=AutonomousState(mood=seed.get("mood", ""), recent_experience=seed.get("recent_experience", ""),
                                   energy=seed.get("energy", ""), anticipating=seed.get("anticipating", "")),
        budget_chars=int(cfg.global_defaults.get("budget_chars", 16000)))
    hist: list[dict] = []

    async def respond(user_line: str, rnd: int) -> str:
        hist.append({"role": "user", "content": user_line})
        msgs = a.build(character_id=cid, scenario="", history=hist)
        if rnd == 0:
            msgs.append({"role": "system", "content": a._human_context(cid, opening=True, now=now)})
        a.set_user_voice_emotion("")
        raw = await _say(llm, msgs, max_tokens=180)
        hist.append({"role": "assistant", "content": raw})
        return _spoken(raw)

    async def opening() -> str:
        msgs = a.build(character_id=cid, scenario="", history=[])
        msgs.append({"role": "system", "content": a._human_context(cid, opening=True, now=now)})
        msgs.append({"role": "system", "content": "（电话刚接通，你主动、自然地开口跟 TA 打个招呼、起个头，别等 TA 先说。）"})
        return _spoken(await _say(llm, msgs, max_tokens=160))

    return opening, respond


def _user_sim(jllm, name, need_desc):
    sys_p = _USER_SYS.format(name=name, need=need_desc)
    hist: list[dict] = []

    async def react(char_line: str) -> str:
        hist.append({"role": "user", "content": f"（{name} 说）{char_line}"})
        out = await _say(jllm, [{"role": "system", "content": sys_p}] + hist, max_tokens=120)
        hist.append({"role": "assistant", "content": out})
        return out.strip()
    return react


async def _judge(jllm, name, need_desc, transcript) -> dict:
    raw = await _say(jllm, [{"role": "system", "content": _JUDGE_SYS.format(name=name, need=need_desc)},
                            {"role": "user", "content": transcript}], max_tokens=500)
    try:
        return json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    except (ValueError, KeyError):
        return {"retention": "?", "_raw": raw[:200]}


_DIMS = [("felt_understood", "被理解"), ("charisma", "魅力"), ("emotional_value", "情绪价值"),
         ("immersion", "沉浸"), ("came_for_it", "诉求满足"), ("retention", "★想再聊")]


async def run(cids, rounds) -> int:
    cfg = load_config()
    fnode = cfg.node("llm_fast")
    if not (fnode.api_key.strip() and fnode.endpoint.strip()):
        print("── 跳过：未配 llm_fast key。线上：set -a; . config/micall.env; set +a && PYTHONPATH=src python3 scripts/companion_eval.py")
        return 0
    llm = make_llm(fnode)                     # 角色：真实管线
    jllm = make_eval_llm(cfg)                 # 模拟用户 + 裁判：顶级评测脑（未配回退 llm_slow→llm_fast）
    eval_model = next((f"{k}·{cfg.node(k).params.get('model', '')}" for k in ("llm_eval", "llm_slow")
                       if cfg.node(k).configured), "llm_fast(回退)")
    specs = effective_specs()
    cids = [c for c in cids if c in specs] or (["vega"] if "vega" in specs else [next(iter(specs))])
    now = datetime.datetime(2026, 6, 28, 20, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))

    print(f"陪伴留存评测 · 角色 {cids} · {len(_NEEDS)} 类诉求 × {rounds} 轮 · 评分脑={eval_model}")
    print("（用户【知道是AI也不在乎】，只看陪伴体验好不好、想不想再聊）\n" + "═" * 60)

    log_lines = []
    for cid in cids:
        name = specs[cid].get("identity", {}).get("name", cid)
        agg = {k: [] for k, _ in _DIMS}
        sample_shown = False
        for nkey, ndesc in _NEEDS:
            opening, respond = _character(cfg, specs, cid, llm, now)
            user = _user_sim(jllm, name, ndesc)
            transcript = []
            char_line = await opening()
            transcript.append(f"{name}：{char_line}")
            for r in range(rounds):
                u = await user(char_line)
                transcript.append(f"用户：{u}")
                char_line = await respond(u, r)
                transcript.append(f"{name}：{char_line}")
            v = await _judge(jllm, name, ndesc, "\n".join(transcript))
            for k, _ in _DIMS:
                try:
                    agg[k].append(float(v.get(k)))
                except (TypeError, ValueError):
                    pass
            ret = v.get("retention", "?")
            print(f"  [{nkey}] ★想再聊 {ret}/10 ｜被理解{v.get('felt_understood','?')} 魅力{v.get('charisma','?')} "
                  f"情绪{v.get('emotional_value','?')} 沉浸{v.get('immersion','?')} 满足{v.get('came_for_it','?')}")
            if v.get("highlight"):
                print(f"     ✨亮点：{v.get('highlight')}")
            if v.get("turnoff"):
                print(f"     ⚠扫兴：{v.get('turnoff')}")
            log_lines.append(f"[{name}|{nkey}] 留存{ret} 被理解{v.get('felt_understood','?')} 魅力{v.get('charisma','?')} "
                             f"情绪{v.get('emotional_value','?')} 沉浸{v.get('immersion','?')} ｜亮点:{v.get('highlight','')} ｜扫兴:{v.get('turnoff','')}")
            if not sample_shown:
                sample_shown = True
                print(f"    ┄┄ 样本对话（{name} · {nkey}）┄┄")
                for ln in transcript:
                    print("    " + ln)

        def _avg(k):
            xs = agg[k]
            return sum(xs) / len(xs) if xs else 0.0
        print(f"\n  ▣ {name} 总评：" + "  ".join(f"{lbl}{_avg(k):.1f}" for k, lbl in _DIMS))
        ret_avg = _avg("retention")
        bar = ("🟢很想再用(≥8)" if ret_avg >= 8 else "🟡还行/可留(6-8)" if ret_avg >= 6
               else "🟠一般(4-6)" if ret_avg >= 4 else "🔴留不住(<4)")
        print(f"     ★留存意愿均分 {ret_avg:.1f}/10 → {bar}")
        print("─" * 60)

    print("\n【分析师：怎么让用户更想长期留下】")
    raw = await _say(jllm, [{"role": "system", "content": _META_SYS},
                            {"role": "user", "content": "\n".join(log_lines)}], max_tokens=1600)
    try:
        m = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
        print(f"  最能打动人：{m.get('strongest')}")
        print(f"  最满足不了：{m.get('weakest_need')}")
        for i, t in enumerate(m.get("top_fixes", []) or [], 1):
            print(f"  待改{i}：{t.get('issue')}\n        → {t.get('fix')}")
        print(f"  总评：{m.get('overall')}")
    except (ValueError, KeyError):
        print("  分析师原文：" + raw)
    print("\n（注：文字评测，无真实声音/音色；真机语音 MiniMax 情绪音色会更打动人 → 此为下限，以真机为准。）")
    return 0


def main() -> int:
    cids = (sys.argv[1].split(",") if len(sys.argv) > 1 else ["vega"])
    rounds = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 6
    return asyncio.run(run([c.strip() for c in cids if c.strip()], max(3, min(10, rounds))))


if __name__ == "__main__":
    raise SystemExit(main())
