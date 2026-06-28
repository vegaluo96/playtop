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
import os
import weakref
from typing import Callable, Dict, Optional, Tuple

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


def pool_limits(max_connections: int = 96, max_keepalive: int = 24) -> "httpx.Limits":
    """共享连接池上限（三家 provider 共用）。单进程 N 通并发时，LLM/TTS/Embedding 各自一个池；池满即
    PoolTimeout → 直接限制能扛多少并发通话。从原 32/8 提到 96/24（阿里云不限连接、受内核 ulimit -n 约束，
    通常 65535），并发头寸从 ~10-15 通提到 ~30-50 通。运维可经 MICALL_HTTP_MAX_CONN /
    MICALL_HTTP_MAX_KEEPALIVE 整体覆盖，无需改代码。"""
    def _envint(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name, "") or default)
        except (ValueError, TypeError):
            return default
    return httpx.Limits(
        max_connections=_envint("MICALL_HTTP_MAX_CONN", max_connections),
        max_keepalive_connections=_envint("MICALL_HTTP_MAX_KEEPALIVE", max_keepalive),
        keepalive_expiry=15.0,
    )

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


# ── provider 瞬时错误重试（LLM/TTS 共用）：一通电话最怕「上游抖一下就把这一轮/这通话打死」。 ──
# 限流(429)/网关抖动(502/504)/上游过载(503/500)/连接·读超时都是【瞬时】的，退避后重试常立刻成功；
# 鉴权(401/403)/请求错(400)/余额是【确定性】的，重试纯属浪费、还拖慢降级。仅在「尚未吐出任何字节」时
# 才可重试——流式一旦开吐，重连会重复输出，必须直接抛给上层兜底。
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


def is_retryable(exc: Exception) -> bool:
    """瞬时可重试错误判定（纯函数，便于测）。识别 httpx 的连接/读/池超时与 5xx/429；
    也兜底匹配 provider 自抛 RuntimeError 文案里的 HTTP 状态码（如 minimax 的 "HTTP 503 · ..."）。"""
    if httpx is not None:
        if isinstance(exc, (
            httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
            httpx.PoolTimeout, httpx.WriteTimeout, httpx.RemoteProtocolError, httpx.ReadError,
        )):
            return True
        if isinstance(exc, httpx.HTTPStatusError):
            try:
                return exc.response.status_code in _RETRYABLE_STATUS
            except Exception:  # pragma: no cover
                return False
        if isinstance(exc, httpx.TimeoutException):  # 其它超时子类兜底
            return True
    s = repr(exc)
    return any((f"HTTP {c}" in s) or (f" {c} " in s) or (f"'{c}'" in s) for c in _RETRYABLE_STATUS)


def retry_backoff_s(attempt: int, base: float = 0.4, cap: float = 4.0) -> float:
    """第 attempt 次重试（0 基）的退避秒：base·2^attempt，封顶 cap。实时路径要短——默认 0.4→0.8→1.6…
    纯函数（无随机/无时钟，便于测）。"""
    try:
        d = float(base) * (2 ** max(0, int(attempt)))
    except Exception:  # pragma: no cover
        d = base
    return min(float(cap), d)
