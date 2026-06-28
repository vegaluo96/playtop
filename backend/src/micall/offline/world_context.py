"""世界上下文：每天全站批量拉一次「真实天气 + 安全时事话题」，所有角色共享，让 TA 像真活在世界里。

第一性原理：
  • 真人不在通话里现查——平时就知道天气、刷到点新鲜事，聊时自然带出。故全部【离线·每天一批】，零通话延迟。
  • 相关性（"角色相关"）在【说话时】免费发生、不在【抓取时】花钱：抓一池【多样】的安全话题（全站共享、1 次/天），
    每个角色按自己人设挑感兴趣的聊——便宜且自然。
  • 数据分两路：天气 = open-meteo（免费、准、每城一次）；时事话题 = 联网脑（grok 等，1 次/天全站共享）。
  • 安全是命门：话题必过安全闸（去政治/灾难/负面/敏感），且永远由角色用家常口吻重述，绝不直给用户。
拉不到一律降级（天气→慢脑季节推测；话题→无），绝不影响实时。
"""
from __future__ import annotations

import asyncio
import datetime
import logging
import re
from typing import Any

from .understanding import parse_profile_update

try:  # open-meteo 走 httpx；缺失则天气功能静默降级
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore

log = logging.getLogger("micall.world")

_SEARCH_TIMEOUT_S = 30.0   # 联网拉话题单次兜底超时（离线）
_WEATHER_TIMEOUT_S = 8.0   # open-meteo 单次超时

# 安全闸：抓回的真实世界内容命中这些就整条丢弃（陪伴产品里角色嘴一歪就是事故，尤其国内合规）。
_UNSAFE = (
    "政治", "时政", "政府", "领导", "主席", "总统", "总理", "书记", "党", "官员", "选举", "议会", "两会", "讲话",
    "抗议", "游行", "示威", "罢工", "war", "战争", "冲突", "军事", "导弹", "核武", "制裁",
    "灾难", "地震", "海啸", "洪水", "山火", "火灾", "爆炸", "坍塌", "事故", "车祸", "空难", "坠机", "坠楼",
    "死亡", "身亡", "遇难", "丧生", "伤亡", "遗体", "尸", "自杀", "凶", "杀", "命案", "枪", "恐怖", "暴力",
    "疫情", "病毒", "确诊", "封控", "瘟疫",
    "股市", "股票", "暴跌", "崩盘", "暴雷", "破产", "裁员", "失业", "经济危机", "通胀", "金融危机",
    "毒品", "涉黄", "色情", "赌", "诈骗", "犯罪", "案件", "判刑", "逮捕", "丑闻", "维权", "敏感",
    "习", "modi", "trump", "biden", "putin",
)


def _is_safe(text: str) -> bool:
    """无敏感/负面命中才算安全。空串不安全。纯函数，便于测试。"""
    t = (text or "").lower()
    return bool(t.strip()) and not any(bad in t for bad in _UNSAFE)


def _date(now: datetime.datetime) -> str:
    return f"{now.year}-{now.month:02d}-{now.day:02d}"


def clean_city(raw: str) -> str:
    """从 identity.residence 取一个干净城市名（去「现居」前缀/区县后缀），供天气查询与去重。取不到返回 ""。"""
    raw = re.sub(r"^现居[于在]?", "", str(raw or "").strip()).strip()
    raw = re.split(r"[·,，、/\s]", raw)[0].strip()
    return raw[:20]


# ── 天气：open-meteo（免费、无 key、全球；中文地名走其 geocoding）──────────────────────
_WMO = {
    0: "晴", 1: "大致晴朗", 2: "多云", 3: "阴", 45: "有雾", 48: "雾凇",
    51: "细毛毛雨", 53: "毛毛雨", 55: "较大毛毛雨", 56: "冻毛毛雨", 57: "较强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "较强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
    80: "阵雨", 81: "较强阵雨", 82: "强阵雨", 85: "小阵雪", 86: "大阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷阵雨伴冰雹",
}
_RAINY = frozenset({51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99})


def _feel(temp: float | None, code: int) -> str:
    if not isinstance(temp, (int, float)):
        return ""
    if temp <= 3:
        return "，挺冷"
    if temp <= 10:
        return "，凉"
    if temp >= 32:
        return "，挺热"
    if temp >= 28:
        return "，有点闷热"
    return "，湿乎乎" if code in _RAINY else ""


def _weather_line(city: str, temp: float | None, code: int) -> str:
    """纯函数：把 open-meteo 取到的温度/天气码拼成一句中文天气。便于测试。"""
    desc = _WMO.get(code, "")
    t = f"{round(temp)}°C" if isinstance(temp, (int, float)) else ""
    body = "，".join([b for b in (desc, t) if b])
    if not body:
        return ""
    return (f"今天{city}{body}{_feel(temp, code)}").strip("，")


def _client() -> "httpx.AsyncClient":
    from ..providers._http import loop_client, pool_limits
    return loop_client(lambda: httpx.AsyncClient(
        timeout=httpx.Timeout(_WEATHER_TIMEOUT_S, connect=5.0), limits=pool_limits()))


async def fetch_weather(city: str) -> str:
    """open-meteo 查 city 当前真实天气 → 一句中文。无 httpx/city/失败 → ""（降级到季节推测）。免费、无 key。"""
    if httpx is None or not city:
        return ""
    try:
        cl = _client()
        g = await asyncio.wait_for(cl.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1, "language": "zh", "format": "json"}), timeout=_WEATHER_TIMEOUT_S)
        g.raise_for_status()
        res = (g.json().get("results") or [])
        if not res:
            return ""
        lat, lon = res[0].get("latitude"), res[0].get("longitude")
        f = await asyncio.wait_for(cl.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lon, "current": "temperature_2m,weather_code"}),
            timeout=_WEATHER_TIMEOUT_S)
        f.raise_for_status()
        cur = f.json().get("current") or {}
        temp = cur.get("temperature_2m")
        try:
            code = int(cur.get("weather_code", -1))
        except (TypeError, ValueError):
            code = -1
        return _weather_line(city, temp, code)
    except Exception as e:
        log.info("open-meteo 天气拉取失败 city=%s：%r", city, e)
        return ""


# ── 时事话题：联网脑（grok 等，全站 1 次/天，多样且安全）────────────────────────────────
def _topics_prompt(date_str: str) -> list[dict]:
    sys = (
        "你是给一群虚拟陪伴角色提供『最近大家在聊什么』的联网助手。用你的【网络检索】查当下中文互联网上"
        "【轻松、大众、安全】的热门话题，**覆盖多个不同领域**（美食/影视综艺/生活方式/季节时令/科技数码/"
        "运动健身/二次元/音乐/旅行 等），好让不同性格的角色各取所需。"
        "严格只输出一个 JSON 对象：{topics:[...]}，5~8 条，每条一句话、具体、轻松、口语。"
        "【硬规矩】绝对避开：政治时政、领导人、灾难事故、死亡伤亡、疫情、战争冲突、股市经济、犯罪丑闻、"
        "维权敏感、任何负面/猎奇/血腥/低俗内容。宁可少给几条，也绝不碰这些。查不到就给空数组。"
    )
    user = f"今天：{date_str}。请联网给我 5~8 条跨领域、安全轻松的当下话题。"
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


async def fetch_topics(search_llm: Any, now: datetime.datetime) -> list[str]:
    """联网脑拉一池跨领域安全话题（全站共享）。无 search_llm/失败 → []。过安全闸。"""
    if search_llm is None:
        return []
    try:
        async def _run() -> str:
            return "".join([t async for t in search_llm.stream(
                _topics_prompt(_date(now)), max_tokens=800, response_format={"type": "json_object"})])
        raw = await asyncio.wait_for(_run(), timeout=_SEARCH_TIMEOUT_S)
        d = parse_profile_update(raw)
        out: list[str] = []
        for t in (d.get("topics") or []):
            ts = str(t).strip()
            if ts and _is_safe(ts):
                out.append(ts[:60])
            if len(out) >= 8:
                break
        return out
    except Exception as e:
        log.info("联网拉时事话题失败（降级到无话题）：%r", e)
        return []


# ── 全站共享世界库（内存，按天）：每天批量刷一次，角色只读、零联网 ────────────────────────
_WORLD: dict[str, Any] = {"date": "", "weather": {}, "topics": []}   # weather: {city: line}; topics: [str]


async def refresh_world(cities: list[str], now: datetime.datetime, search_llm: Any = None) -> dict:
    """全站每日批量：逐城拉真实天气(open-meteo,免费) + 拉一池安全话题(联网脑,1 次) → 写共享库。返回计数。"""
    date_str = _date(now)
    weather: dict[str, str] = {}
    seen: set[str] = set()
    for c in cities:
        c = (c or "").strip()
        if not c or c in seen:
            continue
        seen.add(c)
        w = await fetch_weather(c)
        if w:
            weather[c] = w
    topics = await fetch_topics(search_llm, now)
    _WORLD["date"], _WORLD["weather"], _WORLD["topics"] = date_str, weather, topics
    log.info("🌍 世界库刷新：%d 城真实天气 + %d 条时事话题（date=%s）", len(weather), len(topics), date_str)
    return {"cities": len(weather), "topics": len(topics)}


def _fresh(now: datetime.datetime) -> bool:
    return _WORLD["date"] == _date(now)


def weather_for(city: str, now: datetime.datetime) -> str:
    """读共享库里 city 今天的真实天气；无/过期 → ""。零联网。"""
    return _WORLD["weather"].get(city, "") if (city and _fresh(now)) else ""


def topics_now(now: datetime.datetime) -> list[str]:
    """读共享库里今天的时事话题池（全站共享）；无/过期 → []。零联网。"""
    return list(_WORLD["topics"]) if _fresh(now) else []
