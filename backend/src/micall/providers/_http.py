"""providers/_http.py —— 按事件循环隔离的 httpx.AsyncClient 缓存（三家 provider 共用）。

为什么：管理端连通性测试 / 音色试听走 asyncio.run（每次一个一次性事件循环），通话走 wsserver
常驻循环。同一个 httpx client 跨事件循环复用会污染连接池 → 连接挂死不释放 → 攒满后 PoolTimeout。
故每个事件循环各持一个 client：

  - 常驻循环（wsserver）的 client 永不重建 = 热路径零抖动；
  - 一次性循环用完即弃：其循环关闭/被 GC 后，下次访问时清掉该条目（释放引用 → GC 回收套接字）。

铁律：绝不跨事件循环 `aclose()` 别人的 client —— 会破坏对端正在用的连接（本会话踩过）。
旧 client 靠 keepalive_expiry + 丢引用让 GC/OS 回收，不主动跨循环关闭。
"""
from __future__ import annotations

import asyncio
import weakref
from typing import Callable, Dict, Optional, Tuple

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore

# id(loop) -> (loop 弱引用 或 None, client)。弱引用避免把已结束的一次性循环钉在内存里。
_CLIENTS: "Dict[int, Tuple[Optional[weakref.ref], 'httpx.AsyncClient']]" = {}


def _sweep() -> None:
    """清掉已关闭/已回收事件循环对应的陈旧 client 条目（不 aclose，只丢引用让 GC 回收套接字）。"""
    for k, (ref, cl) in list(_CLIENTS.items()):
        if ref is None:
            continue  # 无运行循环时建的条目：保留按需复用
        lp = ref()
        if lp is None or lp.is_closed():
            _CLIENTS.pop(k, None)


def loop_client(factory: "Callable[[], httpx.AsyncClient]") -> "httpx.AsyncClient":
    """取当前事件循环对应的共享 client；不存在/已关闭则用 factory() 新建并缓存。"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    _sweep()
    key = id(loop)
    ent = _CLIENTS.get(key)
    if ent is not None:
        ref, cl = ent
        lp = ref() if ref is not None else None
        # 命中：client 未关 且 循环身份一致（id 可能在循环销毁后被复用，故再核对对象身份防张冠李戴）
        if not cl.is_closed and ((loop is None and ref is None) or lp is loop):
            return cl
    client = factory()
    _CLIENTS[key] = (weakref.ref(loop) if loop is not None else None, client)
    return client
