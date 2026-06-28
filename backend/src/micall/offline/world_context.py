"""联网脑：离线给角色抓「现居地真实天气 + 安全大众话题」，写进自主状态，让 TA 像真活在世界里。

为什么离线：实时通话里现查 = 慢(1-3s) + 露馅(暴露成 AI)。真人是平时就刷了天气/热搜、聊时自然带出。
所以在挂断后的离线自主推进里顺带抓一次(零通话延迟)，过【安全闸】后存进 AutonomousState.local_context。

数据源：自带网络检索的模型（apiyi grok-4-all / sonar 等，见 nodes.llm_search）。抓回的内容【必过安全闸】
（去政治/灾难/负面/敏感），且永远由角色用家常口吻重述，绝不直给用户。失败一律降级到慢脑的季节推测。
"""
from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Any

from .understanding import parse_profile_update

log = logging.getLogger("micall.world")

_SEARCH_TIMEOUT_S = 30.0  # 联网搜索单次兜底超时（离线，不影响实时）

# 安全闸：抓回的真实世界内容命中这些就整条丢弃（陪伴产品里角色嘴一歪就是事故，尤其国内合规）。
# 宁可少说、退回季节感，绝不让角色复述敏感/负面内容。小写匹配 + 中文关键词。
_UNSAFE = (
    "政治", "时政", "政府", "领导", "主席", "总统", "总理", "书记", "党", "官员", "选举", "议会", "两会", "讲话",
    "抗议", "游行", "示威", "罢工", "war", "战争", "冲突", "军事", "导弹", "核武", "制裁",
    "灾难", "地震", "海啸", "洪水", "台风", "山火", "火灾", "爆炸", "坍塌", "事故", "车祸", "空难", "坠机", "坠楼",
    "死亡", "身亡", "遇难", "丧生", "伤亡", "遗体", "尸", "自杀", "凶", "杀", "命案", "枪", "恐怖", "暴力",
    "疫情", "病毒", "确诊", "封控", "瘟疫",
    "股市", "股票", "暴跌", "崩盘", "暴雷", "破产", "裁员", "失业", "经济危机", "通胀", "金融危机",
    "毒品", "涉黄", "色情", "赌", "诈骗", "犯罪", "案件", "判刑", "逮捕", "丑闻", "维权", "敏感",
    "习", "modi", "trump", "biden", "putin",  # 具体政治人物兜底
)


def _is_safe(text: str) -> bool:
    """无敏感/负面命中才算安全。空串不安全（无意义）。纯函数，便于测试。"""
    t = (text or "").lower()
    return bool(t.strip()) and not any(bad in t for bad in _UNSAFE)


# 按城市缓存（去重多个同城角色，日级 TTL）：同一天同一城只联网抓一次，省 token。
_CACHE: dict[str, tuple[str, str]] = {}   # city -> (date_str, text)


def _search_prompt(city: str, date_str: str) -> list[dict]:
    sys = (
        "你是给一个虚拟角色提供『TA 现居城市当下真实情况』的联网助手。用你的【网络检索】查实时信息。"
        "严格只输出一个 JSON 对象：{weather, topics}。"
        "weather=该城【今天】的真实天气，一句话（阴晴/气温/体感，如『阴有小雨，12°C，湿冷』）。"
        "topics=0到2条该城或全国当下【轻松、大众、无害】的生活/季节/娱乐向话题（如某美食上市、某节气、"
        "天气变化、大家都在追的轻松剧综或梗）。"
        "【硬规矩】topics 绝对【避开】：政治时政、领导人、灾难事故、死亡伤亡、疫情、战争冲突、股市经济、"
        "犯罪丑闻、维权敏感、任何负面/猎奇/血腥/低俗内容。宁可 topics 空数组，也绝不碰这些。查不到就留空。"
    )
    user = f"城市：{city}；今天：{date_str}。请联网查这座城此刻的真实天气 + 至多两条安全轻松的当下话题。"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


async def fetch_world_context(city: str, now: datetime.datetime, search_llm: Any) -> str:
    """联网抓 city 今天真实天气 + 安全话题，过安全闸后拼一句。无 search_llm/city/失败 → ""（优雅降级）。"""
    if search_llm is None or not city:
        return ""
    date_str = f"{now.year}-{now.month:02d}-{now.day:02d}"
    cached = _CACHE.get(city)
    if cached and cached[0] == date_str:
        return cached[1]
    text = ""
    try:
        async def _run() -> str:
            return "".join([t async for t in search_llm.stream(
                _search_prompt(city, date_str), max_tokens=600,
                response_format={"type": "json_object"})])
        raw = await asyncio.wait_for(_run(), timeout=_SEARCH_TIMEOUT_S)
        d = parse_profile_update(raw)
        parts: list[str] = []
        w = str(d.get("weather", "")).strip()
        if w and _is_safe(w):
            parts.append(w)
        topics = d.get("topics")
        if isinstance(topics, list):
            for t in topics:
                ts = str(t).strip()
                if ts and _is_safe(ts):
                    parts.append(ts)
                if len(parts) >= 3:
                    break
        text = "；".join(parts)[:200]
    except Exception as e:   # 网络/鉴权/超时/模型不联网都在此降级，绝不影响实时
        log.info("联网抓现居地近况失败(降级到季节推测) city=%s：%r", city, e)
        text = ""
    if text:                 # 只缓存有效结果；失败不缓存 → 下次推进(节流后)可重试
        _CACHE[city] = (date_str, text)
    return text
