"""记忆遗忘（容量封顶 · 重要性加权）：人脑记忆有限，淡忘流水账、留要紧事 → 事实表不无界膨胀。"""
import unittest

from micall.memory import InMemoryRepository
from micall.memory.repository import _forget_score


class TestForgetScore(unittest.TestCase):
    def test_importance_dominates_recency(self):
        # 老而重要(0.9,最旧) 应当压过 新而琐碎(0.3,最新)：记得准而非记得新
        old_important = _forget_score(0.9, 1.0, 0.0)
        new_trivial = _forget_score(0.3, 1.0, 1.0)
        self.assertGreater(old_important, new_trivial)

    def test_recency_breaks_ties(self):
        # 同等重要性下，新的留分更高（新近只当宽限项）
        self.assertGreater(_forget_score(0.5, 1.0, 1.0), _forget_score(0.5, 1.0, 0.0))

    def test_emotion_weight_counts(self):
        self.assertGreater(_forget_score(0.5, 2.0, 0.5), _forget_score(0.5, 0.5, 0.5))

    def test_handles_none(self):
        self.assertGreaterEqual(_forget_score(None, None, 0.5), 0.0)


class TestPruneFactsInMemory(unittest.TestCase):
    def test_noop_under_cap(self):
        repo = InMemoryRepository()
        for i in range(5):
            repo.add_fact("u", "c", f"事实{i}", importance=0.5)
        self.assertEqual(repo.prune_facts("u", "c", cap=10), 0)
        self.assertTrue(repo.has_facts("u", "c"))

    def test_keeps_important_drops_trivia(self):
        repo = InMemoryRepository()
        # 10 条流水账(0.2) + 3 条要紧事(0.9)，cap=5 → 留 5 条，要紧事必须全留
        for i in range(10):
            repo.add_fact("u", "c", f"流水账{i}", importance=0.2)
        for k in ("最爱吃辣", "怕打雷", "答应一起看展"):
            repo.add_fact("u", "c", k, importance=0.9)
        deleted = repo.prune_facts("u", "c", cap=5)
        self.assertEqual(deleted, 8)                       # 13 → 5
        kept = [t for (t, _w, _v, _imp) in repo._facts[("u", "c")]]
        self.assertEqual(len(kept), 5)
        for k in ("最爱吃辣", "怕打雷", "答应一起看展"):
            self.assertIn(k, kept)                         # 要紧事一条不丢

    def test_preserves_append_order(self):
        repo = InMemoryRepository()
        for i in range(20):
            repo.add_fact("u", "c", f"x{i}", importance=0.5)
        repo.prune_facts("u", "c", cap=8)
        kept = [t for (t, _w, _v, _imp) in repo._facts[("u", "c")]]
        self.assertEqual(kept, sorted(kept, key=lambda t: int(t[1:])))   # 仍按追加序（召回新近成立）

    def test_cap_zero_is_noop(self):
        repo = InMemoryRepository()
        for i in range(5):
            repo.add_fact("u", "c", f"f{i}")
        self.assertEqual(repo.prune_facts("u", "c", cap=0), 0)


if __name__ == "__main__":
    unittest.main()
