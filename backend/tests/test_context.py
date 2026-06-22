import unittest

from micall.context import (
    AutonomousState,
    CharacterRuntime,
    ContextAssembler,
    Insight,
    UserProfile,
)
from micall.memory import InMemoryRepository


class TestMemory(unittest.TestCase):
    def test_recall_relevance(self):
        r = InMemoryRepository()
        r.add_fact("u", "lin_wan", "养了一只猫叫团子")
        r.add_fact("u", "lin_wan", "最近在准备一场面试")
        hits = r.recall("u", "lin_wan", "猫怎么样了", top_k=1)
        self.assertTrue(any("团子" in h for h in hits))

    def test_per_user_isolation(self):
        r = InMemoryRepository()
        r.add_fact("u1", "c", "u1 的秘密")
        self.assertEqual(r.recall("u2", "c", "秘密"), [])  # 不串号（铁律7）

    def test_voice_and_profile_roundtrip(self):
        r = InMemoryRepository()
        self.assertIsNone(r.get_user_voice("u", "c"))
        r.set_user_voice("u", "c", "voice_123", "温柔女声")
        self.assertEqual(r.get_user_voice("u", "c"), "voice_123")
        p = r.get_profile("u", "c")
        self.assertEqual((p.user_id, p.character_id), ("u", "c"))


class TestAssembler(unittest.TestCase):
    def _char(self):
        return CharacterRuntime(
            "lin_wan", "林晚",
            {"core_traits": ["温柔", "会倾听"], "values_and_boundaries": "不无脑迎合"},
            emotion_map={"tender": "gentle", "caring": "warm"},
        )

    def test_build_layers(self):
        prof = UserProfile(
            "u", "lin_wan",
            personality_model=[Insight("焦虑时用自嘲掩饰", 0.7)],
        )
        a = ContextAssembler(self._char(), profile=prof, autonomous=AutonomousState(mood="有点累"))
        msgs = a.build(character_id="lin_wan", scenario="心情树洞",
                       history=[{"role": "user", "content": "在吗"}])
        self.assertEqual(msgs[0]["role"], "system")
        sysmsg = msgs[0]["content"]
        self.assertIn("林晚", sysmsg)                 # L1 人设
        self.assertIn("tender", sysmsg)               # 情绪指令含 emotion_map keys（铁律4）
        self.assertIn("焦虑时用自嘲掩饰", sysmsg)       # L2 画像
        self.assertIn("有点累", sysmsg)                # 尺度四 自主状态
        self.assertIn("心情树洞", sysmsg)              # 情境
        self.assertEqual(msgs[-1], {"role": "user", "content": "在吗"})  # L4 滑窗

    def test_window_trims_oldest(self):
        a = ContextAssembler(CharacterRuntime("c", "N", {}), budget_chars=300)
        hist = [{"role": "user", "content": "x" * 50} for _ in range(20)]
        msgs = a.build(character_id="c", scenario="", history=hist)
        self.assertLess(len(msgs), 1 + 20)            # system + 被裁后的少量滑窗
        self.assertEqual(msgs[-1], hist[-1])          # 保留最近

    def test_recall_injected(self):
        r = InMemoryRepository()
        r.add_fact("u", "lin_wan", "养的猫叫团子")
        prof = UserProfile("u", "lin_wan")
        a = ContextAssembler(self._char(), profile=prof, memory=r)
        msgs = a.build(character_id="lin_wan", scenario="",
                       history=[{"role": "user", "content": "我家猫"}])
        # L3 情节记忆折进末轮 user（而非 system）：保持 system 前缀稳定以命中 DeepSeek 前缀缓存。
        self.assertNotIn("团子", msgs[0]["content"])   # 不进 system → 前缀逐轮稳定
        self.assertIn("团子", msgs[-1]["content"])      # 折进最后一条 user
        self.assertIn("我家猫", msgs[-1]["content"])    # 原 user 内容保留


if __name__ == "__main__":
    unittest.main()
