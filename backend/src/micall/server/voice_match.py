"""音色自定义匹配 —— 用户用自然语言描述想要的声音，LLM 在**免费系统音色库**里挑最贴近的一个。

不给用户列一长串音色让 TA 自己翻，而是「一句话描述 → LLM 理解 → 命中库里一个免费 voice_id」。
LLM 不可用/返回非法时回退关键词启发式，**保证总返回一个库内合法音色**（绝不报错、绝不给库外 ID）。
匹配出的就是真实可用的系统音色，前端拿它直接试听/设为该角色音色。
"""
from __future__ import annotations

import asyncio
import logging
import re

from .voice_library import system_voice_library

log = logging.getLogger("micall.voicematch")


def _catalog_lines() -> str:
    return "\n".join(
        f"{v['voice_id']} | {v['name']} | {v['gender']} | {v['group']}"
        for v in system_voice_library()
    )


def _extract_id(text: str) -> str:
    """从 LLM 输出里抠出一个库内 voice_id（容忍它多说话/加引号/加解释）；命不中 id 再退中文名。"""
    lib = system_voice_library()
    t = text or ""
    # 最长优先：避免 male-qn-qingse 命中到 ...-jingpin 的子串歧义
    for v in sorted(lib, key=lambda x: len(x["voice_id"]), reverse=True):
        if v["voice_id"] in t:
            return v["voice_id"]
    for v in sorted(lib, key=lambda x: len(x["name"]), reverse=True):
        if v["name"] in t:
            return v["voice_id"]
    return ""


_CHILD = re.compile(r"童|小孩|孩子|奶声|萌娃|小朋友")
_FEMALE = re.compile(r"女|妹|姐|少女|萝莉|姑娘|御姐|甜美|嗲|阿姨|妈|奶奶|嫂")
_MALE = re.compile(r"男|哥|弟|爷|叔|学长|少爷|先生|爸|磁性|低沉|浑厚|大叔")


def _heuristic_match(desc: str) -> dict:
    """无 LLM 兜底：按性别 + 描述与音色名/分组的字符重叠打分，挑最高分（永远有结果）。"""
    d = desc or ""
    lib = system_voice_library()
    want_child, want_f, want_m = bool(_CHILD.search(d)), bool(_FEMALE.search(d)), bool(_MALE.search(d))

    def score(v: dict) -> int:
        s = sum(1 for kw in (v["name"], v["group"]) for ch in set(kw) if ch and ch in d)
        if want_child and v["group"] == "童声":
            s += 6
        if want_f and v["gender"] == "女声":
            s += 2
        if want_m and v["gender"] == "男声":
            s += 2
        return s

    best = max(lib, key=score)
    return {**best, "by": "heuristic"}


async def _match_llm(desc: str) -> dict:
    from ..config import load_config
    from ..providers import make_llm

    llm = make_llm(load_config().node("llm_fast"))
    sys = (
        "你是音色匹配助手。下面是一个固定的【免费音色库】。用户用一句话描述想要的声音，"
        "你从库里挑**最贴近**的那一个，直接输出它的 voice_id（库里原样的英文 id），"
        "不要解释、不要输出别的、不要编造库外的 id。\n"
        "音色库（voice_id | 名称 | 性别 | 分组）：\n" + _catalog_lines()
    )
    buf = ""
    async for tok in llm.stream(
        [{"role": "system", "content": sys},
         {"role": "user", "content": f"用户描述：{desc}\n只输出一个库里的 voice_id："}],
        max_tokens=40,
    ):
        buf += tok
    vid = _extract_id(buf)
    if not vid:
        return _heuristic_match(desc)
    v = next(x for x in system_voice_library() if x["voice_id"] == vid)
    return {**v, "by": "llm"}


def match_voice(desc: str) -> dict:
    """同步入口（供 HTTP 处理调用）：返回匹配到的音色 dict（voice_id/name/gender/group/lang/engine/by）。
    LLM 不可用/异常 → 启发式兜底，保证总返回一个库内合法音色。"""
    desc = (desc or "").strip()
    if not desc:
        return _heuristic_match("")
    try:
        return asyncio.run(_match_llm(desc))   # 一次性事件循环；apiyi/minimax client 已按 loop 隔离
    except Exception as e:  # pragma: no cover
        log.warning("音色 LLM 匹配失败，回退启发式：%r", e)
        return _heuristic_match(desc)
