"""IP 归属地解析：把客户端 IP 转成「国家 省 市」中文归属地，供后台通话详情展示。

设计取舍：
- 内网/本机/非法 IP 不外呼，直接给「本机」「内网」「未知」标签——常见于 nginx 未透传真实 IP（127.0.0.1）。
- 公网 IP 调免费地理库（ip-api.com），结果按 IP 缓存进程内（LRU 上限、只缓存成功项），绝不让后台页因外呼慢/挂而卡死。
- 批量解析（一页通话多个游客 IP）用 ip-api 的 batch 接口：最多 100 个 IP 一次请求搞定，
  既避免 N 个并发单查把首屏拖到几十秒，也不会把免费库（单查 ~45 次/分、批量 ~15 次/分）打爆。
- 仅在「后台展示通话列表」时按需解析（不进实时通话链路）。任何异常一律回退空串，前端显原始 IP。
"""
from __future__ import annotations

import ipaddress
import json
import logging
import threading
import urllib.parse
import urllib.request
from collections import OrderedDict

log = logging.getLogger("micall.ipgeo")

_cache: "OrderedDict[str, str]" = OrderedDict()   # ip -> 归属地（只存解析成功的非空项）
_lock = threading.Lock()
_CACHE_CAP = 5000
_MAX_BATCH = 100         # ip-api batch 单次上限；超出的本次留空、下次请求渐进补齐
_TIMEOUT = 4.0
_FIELDS = "status,country,regionName,city,query"
_SINGLE = "http://ip-api.com/json/{ip}?lang=zh-CN&fields=" + _FIELDS
_BATCH = "http://ip-api.com/batch?lang=zh-CN&fields=" + _FIELDS


def _label_for_special(ip: str):
    """私网/本机/非法 IP 的固定标签；返回 None 表示是公网、需要外呼解析。"""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return "未知"
    if a.is_loopback:
        return "本机"
    if a.is_private or a.is_link_local or a.is_reserved:
        return "内网"
    if a.is_unspecified:
        return "未知"
    return None


def _fmt(item: dict) -> str:
    """ip-api 返回项 → 「国家 省 市」（去重相邻同名/空段）。非 success 回空串。"""
    if (item.get("status") or "") != "success":
        return ""
    parts: list[str] = []
    for k in ("country", "regionName", "city"):
        v = (item.get(k) or "").strip()
        if v and v not in parts:
            parts.append(v)
    return " ".join(parts)


def _cache_get(ip: str):
    with _lock:
        if ip in _cache:
            _cache.move_to_end(ip)   # LRU：命中即提到末尾
            return _cache[ip]
    return None


def _cache_put(ip: str, loc: str) -> None:
    if not loc:
        return                       # 不缓存失败（空）项：下次（批量很便宜）再试，避免把短暂失败钉死
    with _lock:
        _cache[ip] = loc
        _cache.move_to_end(ip)
        while len(_cache) > _CACHE_CAP:
            _cache.popitem(last=False)   # 逐出最久未用，避免「满了整清」的雪崩


def _lookup(ip: str) -> str:
    """单个公网 IP 外呼解析。任何异常回空串。"""
    try:
        url = _SINGLE.format(ip=urllib.parse.quote(ip))
        req = urllib.request.Request(url, headers={"User-Agent": "micall-admin/1.0"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:   # noqa: S310 (固定可信 host)
            return _fmt(json.loads(r.read().decode("utf-8", "ignore")))
    except Exception as e:
        log.debug("IP 归属地解析失败 %s：%r", ip, e)
        return ""


def _lookup_batch(ips: list[str]) -> dict[str, str]:
    """一次外呼解析多个公网 IP（ip-api batch）。失败整体回空 dict。"""
    try:
        body = json.dumps(ips).encode("utf-8")
        req = urllib.request.Request(
            _BATCH, data=body,
            headers={"Content-Type": "application/json", "User-Agent": "micall-admin/1.0"},
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:   # noqa: S310
            arr = json.loads(r.read().decode("utf-8", "ignore"))
        res: dict[str, str] = {}
        if isinstance(arr, list):
            for item in arr:
                if isinstance(item, dict):
                    res[item.get("query") or ""] = _fmt(item)
        return res
    except Exception as e:
        log.debug("IP 归属地批量解析失败（%d 个）：%r", len(ips), e)
        return {}


def ip_location(ip: str) -> str:
    """单个 IP → 归属地（带缓存）。内网/本机/非法直接给标签，公网外呼解析。"""
    ip = (ip or "").strip()
    if not ip:
        return ""
    special = _label_for_special(ip)
    if special is not None:
        return special
    cached = _cache_get(ip)
    if cached is not None:
        return cached
    loc = _lookup(ip)
    _cache_put(ip, loc)
    return loc


def ip_locations(ips, max_lookups: int = _MAX_BATCH) -> dict[str, str]:
    """批量解析一组 IP → {ip: 归属地}。已缓存/内网的直接出；未缓存公网的一次 batch 外呼搞定，
    本次外呼数封顶 max_lookups（超出留空、下次再补），防后台页卡顿/被免费库限流。"""
    out: dict[str, str] = {}
    todo: list[str] = []
    for raw in ips:
        ip = (raw or "").strip()
        if not ip or ip in out:
            continue
        special = _label_for_special(ip)
        if special is not None:
            out[ip] = special
            continue
        cached = _cache_get(ip)
        if cached is not None:
            out[ip] = cached
        elif len(todo) < max_lookups:
            todo.append(ip)
        else:
            out[ip] = ""   # 超出本次外呼上限：先留空（前端回退显原始 IP），下次请求再补
    if todo:
        res = _lookup_batch(todo)
        for ip in todo:
            loc = res.get(ip, "")
            _cache_put(ip, loc)
            out[ip] = loc
    return out
