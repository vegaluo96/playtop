"""通话记录账号级软删除（用户端删除=隐藏，跨设备一致；后台统计仍计入）。"""
import unittest

from micall.memory.repository import InMemoryRepository


class TestCallSoftDelete(unittest.TestCase):
    def _repo(self) -> InMemoryRepository:
        r = InMemoryRepository()
        r.add_call("u1", "lin_wan", "chat", 30, "ended")
        r.add_call("u1", "lin_wan", "chat", 20, "ended")
        return r

    def test_list_calls_have_ids(self):
        r = self._repo()
        calls = r.list_calls("u1")
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("id" in c for c in calls))

    def test_hide_filters_user_list_but_keeps_admin_stats(self):
        r = self._repo()
        target = r.list_calls("u1")[0]["id"]
        self.assertEqual(r.hide_calls("u1", [target]), 1)
        remaining = r.list_calls("u1")
        self.assertEqual(len(remaining), 1)                    # 用户端少一条
        self.assertNotIn(target, [c["id"] for c in remaining])
        self.assertEqual(len(r.list_all_calls()), 2)           # 后台「通话」仍计入隐藏的

    def test_hide_is_per_account(self):
        # 别的用户删不动我的记录
        r = self._repo()
        target = r.list_calls("u1")[0]["id"]
        self.assertEqual(r.hide_calls("u2", [target]), 0)
        self.assertEqual(len(r.list_calls("u1")), 2)

    def test_hide_empty_or_bad_ids(self):
        r = self._repo()
        self.assertEqual(r.hide_calls("u1", []), 0)
        self.assertEqual(r.hide_calls("u1", ["nope"]), 0)
        self.assertEqual(len(r.list_calls("u1")), 2)


class TestCallTranscript(unittest.TestCase):
    """通话对话内容留存：后台「通话详情」据此展示逐句对话（测试期开；隐私关时不留存）。"""

    def test_transcript_roundtrips_to_admin_list(self):
        r = InMemoryRepository()
        tx = [{"role": "user", "content": "你好呀"}, {"role": "assistant", "content": "嗨，最近怎么样"}]
        r.add_call("u1", "shen_du", "chat", 60, "ended", transcript=tx)
        row = r.list_all_calls()[0]
        self.assertEqual(len(row["transcript"]), 2)
        self.assertEqual(row["transcript"][0]["content"], "你好呀")

    def test_transcript_defaults_empty_when_omitted(self):
        # 不传 transcript（隐私关 / 旧调用）→ 空列表，后台显示「无文字记录」，不报错。
        r = InMemoryRepository()
        r.add_call("u1", "shen_du", "chat", 60, "ended")
        self.assertEqual(r.list_all_calls()[0]["transcript"], [])

    def test_record_call_gate_off_stores_no_transcript(self):
        # store_call_transcripts=false → wsserver._call_transcript 返回空（隐私开关可关留存）。
        from types import SimpleNamespace
        from micall.config import load_config
        from micall.server.wsserver import SignalingServer
        cfg = load_config()
        cfg.global_defaults["store_call_transcripts"] = False
        s = SignalingServer(cfg, repo=InMemoryRepository())
        sess = SimpleNamespace(history=[{"role": "user", "content": "在吗"}], character_id="shen_du")
        self.assertEqual(s._call_transcript(sess), [])
        cfg.global_defaults["store_call_transcripts"] = True
        self.assertEqual(len(s._call_transcript(sess)), 1)   # 开关开 → 取到对话


if __name__ == "__main__":
    unittest.main()
