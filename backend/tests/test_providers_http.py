"""providers/_http.loop_client —— 按事件循环隔离的 httpx client 缓存（不依赖网络/httpx）。

验证：同一事件循环复用同一 client（热路径零重建）；一次性循环关闭后下次访问清理旧条目、建新 client
（绝不跨循环复用 → 防 PoolTimeout）。
"""
import asyncio
import unittest

from micall.providers import _http


class _FakeClient:
    def __init__(self) -> None:
        self.is_closed = False


async def _grab(factory):
    return _http.loop_client(factory)


class TestLoopClient(unittest.TestCase):
    def setUp(self):
        _http._CLIENTS.clear()

    def test_same_loop_reuses_client(self):
        calls = []

        def factory():
            c = _FakeClient()
            calls.append(c)
            return c

        async def go():
            return _http.loop_client(factory), _http.loop_client(factory)

        a, b = asyncio.run(go())
        self.assertIs(a, b)            # 同循环 → 同 client
        self.assertEqual(len(calls), 1)  # factory 只调一次

    def test_new_loop_builds_new_and_sweeps_closed(self):
        calls = []

        def factory():
            c = _FakeClient()
            calls.append(c)
            return c

        asyncio.run(_grab(factory))   # 一次性循环 1
        asyncio.run(_grab(factory))   # 一次性循环 2：旧条目应被清扫，新建 client
        self.assertEqual(len(calls), 2)
        # 清扫后不应残留已关闭循环的条目
        live = [k for k, (ref, _) in _http._CLIENTS.items() if ref is not None]
        self.assertLessEqual(len(live), 1)


if __name__ == "__main__":
    unittest.main()
