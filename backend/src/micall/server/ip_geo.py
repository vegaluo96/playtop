"""IP 归属地解析：把客户端 IP 转成「国家 省 市」中文归属地，供后台通话详情展示。

设计取舍：
- 内网/本机/非法 IP 不外呼，直接给「本机」「内网」「未知」标签——常见于 nginx 未透传真实 IP（127.0.0.1）。
- 公网 IP 调免费地理库（带超时、内存缓存、失败回空），绝不让后台页面因外呼慢/挂而卡死。
- 仅在「后台展示通话列表」时按需解析（不进实时通话链路），结果按 IP 缓存进程内、重复 IP 不再外呼。
- 批量解析（一页通话多个游客 IP）走小线程池并发，整体封顶超时，避免逐个串行把页面拖到几十秒。
"""
from __future__ import annotations

import ipaddress
import json
import logging
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

log = logging.getLogger("micall.ipgeo")

_cache: dict[str, str] = {}
_lock = threading.Lock()
_CACHE_CAP = 5000

# 免费、无需 key、支持中文（lang=zh-CN）。只取省市字段，省流量。失败一律回退空串。
_API = "http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,country,regionName,city"
_TIMEOUT = 2.5


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


def _lookup(ip: str) -> str:
    """实际外呼解析一个公网 IP → 「国家 省 市」（去重相邻同名/空段）。任何异常回空串。"""
    try:
        url = _API.format(ip=urllib.parse.quote(ip))
        req = urllib.request.Request(url, headers={"User-Agent": "micall-admin/1.0"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:   # noqa: S310 (固定可信 host)
            data = json.loads(r.read().decode("utf-8", "ignore"))
        if (data.get("status") or "") != "success":
            return ""
        parts: list[str] = []
        for k in ("country", "regionName", "city"):
            v = (data.get(k) or "").strip()
            if v and v not in parts:
                parts.append(v)
        return " ".join(parts)
    except Exception as e:
        log.debug("IP 归属地解析失败 %s：%r", ip, e)
        return ""


def ip_location(ip: str) -> str:
    """单个 IP → 归属地（带缓存）。内网/本机/非法直接给标签，公网外呼解析。"""
    ip = (ip or "").strip()
    if not ip:
        return ""
    special = _label_for_special(ip)
    if special is not None:
        return special
    with _lock:
        if ip in _cache:
            return _cache[ip]
    loc = _lookup(ip)
    with _lock:
        if len(_cache) >= _CACHE_CAP:
            _cache.clear()   # 简单封顶：满了整清，避免无界增长（归属地非关键、重查成本低）
        _cache[ip] = loc
    return loc


_MAX_LOOKUPS_PER_CALL = 24   # 单次批量解析最多外呼这么多未缓存公网 IP：既封住后台页首屏延迟（≤几秒），
                             # 也避免一次性把免费库（ip-api.com ~45 次/分）打爆。超出的先空着，下次请求再渐进补齐（缓存随之变热）。


def ip_locations(ips, max_lookups: int = _MAX_LOOKUPS_PER_CALL) -> dict[str, str]:
    """批量解析一组 IP → {ip: 归属地}。已缓存/内网的直接出；未缓存公网的走小线程池并发外呼，
    单次外呼数封顶 max_lookups（超出的本次留空、不外呼），防后台页卡顿/被免费库限流。"""
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
        with _lock:
            cached = _cache.get(ip)
        if cached is not None:
            out[ip] = cached
        elif len(todo) < max_lookups:
            todo.append(ip)
        else:
            out[ip] = ""   # 超出本次外呼上限：先留空（前端回退显原始 IP），下次请求再补
    if todo:
        with ThreadPoolExecutor(max_workers=min(8, len(todo))) as ex:
            futs = {ex.submit(ip_location, ip): ip for ip in todo}
            for f in as_completed(futs):
                out[futs[f]] = (f.result() or "")
    return out
