"""续接重拨：网络掉线后窗口内重拨【同一角色】→ 回灌最近几轮、AI 接着聊（不重新自我介绍）。

覆盖：
  ① _stash_thread/_take_continuation 暂存-取回（一次性消费、过期、换角色不续、游客按 IP、薄历史不存）。
  ② _make_session 命中续接 → 播种 history + _continuation；无暂存 → 全新空 history。
  ③ CallSession 续接构造 + _run_opening 守卫逻辑（续接模式带 history 也放行先开口）。
"""
import time
import unittest
from types import SimpleNamespace

from micall.config import load_config
from micall.context import CharacterRuntime, ContextAssembler
from micall.memory import InMemoryRepository
from micall.providers import StubLLM, StubTTS
from micall.session import CallSession
import micall.server.wsserver as ws
from micall.server.wsserver import SignalingServer


def _noop(*a, **k):
    return None


_HIST = [{"role": "user", "content": "我升职了"}, {"role": "assistant", "content": "恭喜你！"}]


class TestThreadStash(unittest.TestCase):
    def _server(self):
        return SignalingServer(load_config(), repo=InMemoryRepository())

    def _sess(self, history, character_id="vega"):
        return SimpleNamespace(history=list(history), character_id=character_id)

    def test_stash_and_take_roundtrip(self):
        s = self._server()
        s._stash_thread("u1", "1.2.3.4", self._sess(_HIST))
        self.assertEqual(s._take_continuation("u1", "1.2.3.4", "vega"), _HIST)
        self.assertIsNone(s._take_continuation("u1", "1.2.3.4", "vega"))   # 一次性消费

    def test_thin_history_not_stashed(self):
        s = self._server()
        s._stash_thread("u1", "ip", self._sess([{"role": "user", "content": "喂"}]))  # <2 条
        self.assertIsNone(s._take_continuation("u1", "ip", "vega"))

    def test_window_expiry(self):
        s = self._server()
        s._stash_thread("u1", "ip", self._sess(_HIST))
        key = s._thread_key("u1", "ip", "vega")
        s._recent_thread[key]["ts"] = time.time() - (ws._CONTINUATION_WINDOW_S + 10)
        self.assertIsNone(s._take_continuation("u1", "ip", "vega"))

    def test_different_character_no_continuation(self):
        s = self._server()
        s._stash_thread("u1", "ip", self._sess(_HIST, character_id="vega"))
        self.assertIsNone(s._take_continuation("u1", "ip", "tuan_zi"))   # 换角色不续接

    def test_guest_keyed_by_ip(self):
        s = self._server()
        s._stash_thread(ws._ANON, "5.5.5.5", self._sess(_HIST))
        self.assertEqual(s._take_continuation(ws._ANON, "5.5.5.5", "vega"), _HIST)   # 游客按 IP 也能续


class TestMakeSessionContinuation(unittest.TestCase):
    def _server(self):
        return SignalingServer(load_config(), repo=InMemoryRepository())

    def test_make_session_seeds_and_flags(self):
        s = self._server()
        hist = [{"role": "user", "content": "聊到想去旅行"}, {"role": "assistant", "content": "想去哪？"}]
        s._stash_thread("u1", "1.2.3.4", SimpleNamespace(history=hist, character_id="vega"))
        sess = s._make_session(emit=_noop, character_id="vega", scenario="", user_id="u1", client_ip="1.2.3.4")
        self.assertEqual(sess.history, hist)
        self.assertTrue(sess._continuation)
        self.assertIsNone(s._take_continuation("u1", "1.2.3.4", "vega"))   # 已被消费

    def test_make_session_fresh_when_no_stash(self):
        s = self._server()
        sess = s._make_session(emit=_noop, character_id="vega", scenario="", user_id="u9", client_ip="9.9.9.9")
        self.assertEqual(sess.history, [])
        self.assertFalse(sess._continuation)


class TestContinuationSession(unittest.TestCase):
    def _session(self, seed_history, continuation):
        config = load_config()
        char = CharacterRuntime("vega", "维佳", {"core_traits": ["直接"]})
        repo = InMemoryRepository()
        assembler = ContextAssembler(char, profile=repo.get_profile("u", "vega"), memory=repo)
        return CallSession(config=config, emit=_noop, llm=StubLLM(["在"]), tts=StubTTS(),
                           assembler=assembler, character_id="vega", scenario="", remaining_seconds=30,
                           voice_id="v1", seed_history=seed_history, continuation=continuation)

    def test_seed_history_and_flag(self):
        hist = [{"role": "user", "content": "刚说到加班"}, {"role": "assistant", "content": "对，你别太累"}]
        s = self._session(hist, True)
        self.assertEqual(s.history, hist)
        self.assertTrue(s._continuation)

    def test_fresh_session_empty_history(self):
        s = self._session(None, False)
        self.assertEqual(s.history, [])
        self.assertFalse(s._continuation)

    def test_opening_guard_continuation_vs_fresh(self):
        # _run_opening 守卫 = `(history and not _continuation)`：续接模式带 history 也放行先开口；
        # 非续接 + 有 history（用户已先说）= 拦截让位。直接对守卫表达式取证。
        hist = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        cont = self._session(hist, True)
        self.assertFalse(bool(cont.history) and not cont._continuation)   # 放行
        fresh = self._session(hist, False)
        self.assertTrue(bool(fresh.history) and not fresh._continuation)  # 拦截


if __name__ == "__main__":
    unittest.main()
