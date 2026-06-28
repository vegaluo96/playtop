"""桶一·可靠性：别让一通电话半路死掉。

覆盖：
  ① provider 瞬时错误重试判定 is_retryable / 退避 retry_backoff_s（纯函数）。
  ② ApiyiLLM.stream 的重试回路：吐字前 503 退避重试成功；已吐字遇错不重试（防重复输出）；
     非瞬时错误（401）立即抛。用假 client 直接驱动重试逻辑，不依赖 httpx/网络。
  ③ /api/health 的 health_snapshot：节点配置/持久化 → status·degraded。
  ④ 限流器 _rate_sweep：清掉过期 (ip,key) 条目、保留有效条目（防内存无界增长）。
"""
import asyncio
import unittest
from types import SimpleNamespace

from micall.providers import _http
from micall.providers import apiyi_llm
from micall.server import userapi


# ────────────────────────── ① 纯函数：重试判定 + 退避 ──────────────────────────
class TestRetryHelpers(unittest.TestCase):
    def test_is_retryable_status_in_message(self):
        # provider 自抛 RuntimeError 文案里带状态码（minimax 的 "HTTP 503 · ..."）→ 瞬时可重试
        self.assertTrue(_http.is_retryable(RuntimeError("HTTP 503 · upstream overloaded")))
        self.assertTrue(_http.is_retryable(RuntimeError("MiniMax base_resp · HTTP 429 rate limited")))
        self.assertTrue(_http.is_retryable(RuntimeError("gateway HTTP 502 bad")))

    def test_is_retryable_excludes_deterministic(self):
        # 鉴权/请求错/余额是确定性错误：重试纯属浪费 → 不重试
        self.assertFalse(_http.is_retryable(RuntimeError("HTTP 401 · bad key")))
        self.assertFalse(_http.is_retryable(RuntimeError("HTTP 400 · invalid params")))
        self.assertFalse(_http.is_retryable(ValueError("not a network error")))

    def test_retry_backoff_grows_and_caps(self):
        self.assertAlmostEqual(_http.retry_backoff_s(0, 0.4), 0.4)
        self.assertAlmostEqual(_http.retry_backoff_s(1, 0.4), 0.8)
        self.assertAlmostEqual(_http.retry_backoff_s(2, 0.4), 1.6)
        self.assertAlmostEqual(_http.retry_backoff_s(10, 0.4, cap=4.0), 4.0)  # 封顶
        self.assertAlmostEqual(_http.retry_backoff_s(0, 0.0), 0.0)            # 0 起步=不等待（测试用）


# ────────────────────────── 假 httpx client（驱动 stream 重试回路）──────────────────────────
class _FakeStreamCtx:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *a):
        return False


class _FakeResp:
    """status_exc：raise_for_status 时抛（模拟 4xx/5xx）。lines：SSE 行；元素若是 Exception 则迭代到此抛出。"""
    def __init__(self, *, status_exc=None, lines=None):
        self._status_exc = status_exc
        self._lines = lines or []

    def raise_for_status(self):
        if self._status_exc:
            raise self._status_exc

    async def aiter_lines(self):
        for ln in self._lines:
            if isinstance(ln, Exception):
                raise ln
            yield ln


class _FakeClient:
    def __init__(self, scripted):
        self._scripted = list(scripted)
        self.calls = 0

    def stream(self, method, url, **kw):
        resp = self._scripted[self.calls]
        self.calls += 1
        return _FakeStreamCtx(resp)


class _CapClient(_FakeClient):
    """记录每次请求的 json payload，便于断言 response_format 是否被带上/去掉。"""
    def __init__(self, scripted):
        super().__init__(scripted)
        self.payloads = []

    def stream(self, method, url, **kw):
        self.payloads.append(kw.get("json") or {})
        return super().stream(method, url, **kw)


def _tok(text):
    return 'data: {"choices":[{"delta":{"content":"%s"}}]}' % text


class TestLLMRetry(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # ApiyiLLM.__init__ 在 httpx 缺失时会拒绝构造；本测不碰真 httpx，置个真值绕过守卫即可。
        self._orig_httpx = apiyi_llm.httpx
        self._orig_client = apiyi_llm._shared_client
        apiyi_llm.httpx = object()

    def tearDown(self):
        apiyi_llm.httpx = self._orig_httpx
        apiyi_llm._shared_client = self._orig_client

    def _make_llm(self, fake):
        apiyi_llm._shared_client = lambda: fake
        node = SimpleNamespace(
            configured=True, endpoint="http://x/v1/chat/completions", api_key="k", name="llm_fast",
            params={"model": "m", "max_retries": 1, "retry_base_s": 0.0, "report_usage": False},
        )
        return apiyi_llm.ApiyiLLM(node)

    async def _collect(self, llm):
        return "".join([t async for t in llm.stream([{"role": "user", "content": "hi"}])])

    async def test_retries_transient_before_first_token(self):
        fake = _FakeClient([
            _FakeResp(status_exc=RuntimeError("HTTP 503 · overloaded")),   # 第一次：上游过载
            _FakeResp(lines=[_tok("嗨"), "data: [DONE]"]),                  # 重试：成功
        ])
        llm = self._make_llm(fake)
        out = await self._collect(llm)
        self.assertEqual(out, "嗨")
        self.assertEqual(fake.calls, 2)   # 确实重试了一次

    async def test_no_retry_after_yield(self):
        # 已经吐过字再断流：绝不重试（重连会重复念）——直接抛给上层兜底。
        fake = _FakeClient([
            _FakeResp(lines=[_tok("嗨"), RuntimeError("HTTP 503 · mid-stream")]),
            _FakeResp(lines=["data: [DONE]"]),   # 不应被触达
        ])
        llm = self._make_llm(fake)
        got = []
        with self.assertRaises(RuntimeError):
            async for t in llm.stream([{"role": "user", "content": "hi"}]):
                got.append(t)
        self.assertEqual(got, ["嗨"])
        self.assertEqual(fake.calls, 1)   # 没重试

    async def test_no_retry_on_deterministic_error(self):
        fake = _FakeClient([
            _FakeResp(status_exc=RuntimeError("HTTP 401 · bad key")),
            _FakeResp(lines=["data: [DONE]"]),   # 不应被触达
        ])
        llm = self._make_llm(fake)
        with self.assertRaises(RuntimeError):
            await self._collect(llm)
        self.assertEqual(fake.calls, 1)   # 鉴权错不重试

    def test_payload_response_format_optional(self):
        """离线 JSON 调用传 response_format 才进 payload；不传则没有（实时口语路径不带）。"""
        llm = self._make_llm(_FakeClient([]))
        msgs = [{"role": "user", "content": "hi"}]
        self.assertNotIn("response_format", llm._payload(msgs, 0.8, 100))
        p = llm._payload(msgs, 0.8, 100, {"type": "json_object"})
        self.assertEqual(p["response_format"], {"type": "json_object"})

    async def test_response_format_400_drops_and_retries(self):
        """模型/网关不接受 response_format(400) → 去掉该字段重试一次，不算瞬时重试，离线 JSON 不崩。"""
        fake = _CapClient([
            _FakeResp(status_exc=RuntimeError("HTTP 400 · response_format unsupported")),
            _FakeResp(lines=[_tok("{}"), "data: [DONE]"]),
        ])
        llm = self._make_llm(fake)
        out = "".join([t async for t in llm.stream(
            [{"role": "user", "content": "hi"}], response_format={"type": "json_object"})])
        self.assertEqual(out, "{}")
        self.assertEqual(fake.calls, 2)
        self.assertIn("response_format", fake.payloads[0])      # 第一次带
        self.assertNotIn("response_format", fake.payloads[1])   # 去掉后重试


# ────────────────────────── ③ /api/health 快照 ──────────────────────────
class _FakeNode:
    def __init__(self, configured):
        self.configured = configured


class _FakeConfig:
    def __init__(self, conf):
        self._conf = conf

    def node(self, k):
        if k not in self._conf:
            raise KeyError(k)
        return _FakeNode(self._conf[k])


class _PgRepo:            # 名字不是 InMemoryRepository → 视为已持久化
    pass


class InMemoryRepository:  # 同名模拟内存仓储 → persisted False
    pass


_ALL_ON = {k: True for k in userapi._HEALTH_NODES}


class TestHealthSnapshot(unittest.TestCase):
    def test_all_configured_ok(self):
        snap = userapi.health_snapshot(_FakeConfig(_ALL_ON), _PgRepo())
        self.assertEqual(snap["status"], "ok")
        self.assertEqual(snap["degraded"], [])
        self.assertTrue(snap["persisted"])
        self.assertTrue(all(snap["nodes"].values()))

    def test_missing_critical_node_degraded(self):
        conf = dict(_ALL_ON, tts=False)
        snap = userapi.health_snapshot(_FakeConfig(conf), _PgRepo())
        self.assertEqual(snap["status"], "degraded")
        self.assertIn("tts", snap["degraded"])
        self.assertFalse(snap["nodes"]["tts"])

    def test_noncritical_missing_stays_ok(self):
        # embedding 不在关键三件套：缺了仍 ok（只是没语义召回），但 nodes 如实反映 False
        conf = dict(_ALL_ON, embedding=False)
        snap = userapi.health_snapshot(_FakeConfig(conf), _PgRepo())
        self.assertEqual(snap["status"], "ok")
        self.assertFalse(snap["nodes"]["embedding"])

    def test_in_memory_repo_not_persisted(self):
        snap = userapi.health_snapshot(_FakeConfig(_ALL_ON), InMemoryRepository())
        self.assertFalse(snap["persisted"])


# ────────────────────────── ④ 限流器内存清理 ──────────────────────────
class TestRateSweep(unittest.TestCase):
    def setUp(self):
        userapi._RATE.clear()

    def tearDown(self):
        userapi._RATE.clear()

    def test_sweep_drops_expired_keeps_live(self):
        now = 100000.0
        userapi._RATE[("1.1.1.1", "login")] = [now - 1000.0]    # login 窗 300 → 过期
        userapi._RATE[("2.2.2.2", "login")] = [now - 10.0]      # 窗内 → 留
        userapi._RATE[("3.3.3.3", "register")] = [now - 7200.0]  # register 窗 3600 → 过期
        userapi._RATE[("4.4.4.4", "register")] = [now - 100.0, now - 7200.0]  # 有一个窗内 → 留
        removed = userapi._rate_sweep(now)
        self.assertEqual(removed, 2)
        self.assertIn(("2.2.2.2", "login"), userapi._RATE)
        self.assertIn(("4.4.4.4", "register"), userapi._RATE)
        self.assertNotIn(("1.1.1.1", "login"), userapi._RATE)
        self.assertNotIn(("3.3.3.3", "register"), userapi._RATE)


if __name__ == "__main__":
    unittest.main()
