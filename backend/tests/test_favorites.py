import unittest

from micall.memory.repository import InMemoryRepository


class TestFavorites(unittest.TestCase):
    def _repo(self):
        r = InMemoryRepository()
        r.create_user("u1", "a@b.com", "h")
        r.create_user("u2", "c@d.com", "h")
        return r

    def test_favorites_roundtrip_and_isolation(self):
        r = self._repo()
        self.assertEqual(r.list_favorites("u1"), [])
        r.set_favorite("u1", "vega", True)
        r.set_favorite("u1", "bai_ling", True)
        self.assertEqual(set(r.list_favorites("u1")), {"vega", "bai_ling"})
        r.set_favorite("u1", "vega", False)          # 取消收藏
        self.assertEqual(r.list_favorites("u1"), ["bai_ling"])
        r.set_favorite("u1", "bai_ling", True)        # 重复收藏幂等
        self.assertEqual(r.list_favorites("u1"), ["bai_ling"])
        self.assertEqual(r.list_favorites("u2"), [])  # 账号隔离

    def test_char_call_counts(self):
        r = self._repo()
        r.add_call("u1", "vega", "chat", 60, "ended")
        r.add_call("u2", "vega", "chat", 30, "ended")
        r.add_call("u1", "bai_ling", "chat", 10, "ended")
        counts = r.char_call_counts()
        self.assertEqual(counts.get("vega"), 2)      # 跨用户合计
        self.assertEqual(counts.get("bai_ling"), 1)


if __name__ == "__main__":
    unittest.main()
