import asyncio
import json
import unittest

from micall.context.models import AutonomousState, CharacterRuntime
from micall.memory import InMemoryRepository
from micall.offline import (
    AutonomyEngine,
    build_autonomy_prompt,
    describe_gap,
    due_to_advance,
    parse_autonomous_state,
)
from micall.providers import StubLLM


class TestGap(unittest.TestCase):
    def test_buckets(self):
        self.assertEqual(describe_gap(2), "才几个小时")
        self.assertEqual(describe_gap(30), "一两天")
        self.assertEqual(describe_gap(72), "好几天")
        self.assertEqual(describe_gap(24 * 10), "一周多")


class TestThrottle(unittest.TestCase):
    def test_due_to_advance(self):
        throttle = 3 * 3600
        self.assertTrue(due_to_advance(None, 1000.0, throttle))          # 从未推过 → 推
        self.assertFalse(due_to_advance(1000.0, 1000.0 + 60, throttle))  # 刚推过 1 分钟 → 不推
        self.assertTrue(due_to_advance(1000.0, 1000.0 + throttle, throttle))  # 满节流窗 → 推


class TestPrompt(unittest.TestCase):
    def test_prompt_independence_and_gap(self):
        char = CharacterRuntime("lin_wan", "林晚", {"core_traits": ["温柔"]})
        msgs = build_autonomy_prompt(char, 24 * 8)
        sys = msgs[0]["content"]
        self.assertIn("林晚", sys)
        self.assertIn("独立", sys)          # 状态独立于用户需求
        self.assertIn("一周多", sys)         # 间隔粒度注入

    def test_prompt_debiased_and_has_anticipating(self):
        """第一性原理改写：不再默认疲惫、状态有起伏，并要求 anticipating 维度。"""
        char = CharacterRuntime("lin_wan", "林晚", {"core_traits": ["温柔"]})
        sys = build_autonomy_prompt(char, 6)[0]["content"]
        self.assertIn("不要默认疲惫", sys)   # 去掉「累」锚点
        self.assertIn("起伏", sys)           # 状态有起伏、多数日子还行
        self.assertIn("anticipating", sys)   # 新增「在期待的小事」维度


class TestParse(unittest.TestCase):
    def test_parse_state(self):
        s = parse_autonomous_state(
            '{"mood":"有点低落","recent_experience":"搬了家","energy":"有点累","anticipating":"周末去看海"}')
        self.assertEqual(s.mood, "有点低落")
        self.assertEqual(s.recent_experience, "搬了家")
        self.assertEqual(s.energy, "有点累")
        self.assertEqual(s.anticipating, "周末去看海")   # 新维度解析

    def test_parse_local_context(self):
        s = parse_autonomous_state('{"mood":"还行","local_context":"上海梅雨季，闷湿"}')
        self.assertEqual(s.local_context, "上海梅雨季，闷湿")

    def test_parse_garbage(self):
        s = parse_autonomous_state("没有 JSON")
        self.assertEqual((s.mood, s.recent_experience, s.energy, s.anticipating, s.local_context),
                         ("", "", "", "", ""))


class TestLocalContext(unittest.TestCase):
    """现居地近况：让「现居X」有意义——慢脑按真实日期+城市生成季节/时令感（无实时联网）。"""

    def test_city_parsing(self):
        from micall.offline.autonomy import _city_of
        def char(res):
            return CharacterRuntime("c", "维佳", {}, {"residence": res})
        self.assertEqual(_city_of(char("现居上海")), "上海")
        self.assertEqual(_city_of(char("上海·徐汇")), "上海")
        self.assertEqual(_city_of(char("北京 朝阳区")), "北京")
        self.assertEqual(_city_of(char("")), "")
        self.assertEqual(_city_of(CharacterRuntime("c", "维佳", {})), "")   # 无 identity

    def test_prompt_has_local_context_when_residence(self):
        char = CharacterRuntime("c", "维佳", {"core_traits": ["飒"]}, {"residence": "上海"})
        sys = build_autonomy_prompt(char, 6)[0]["content"]
        self.assertIn("local_context", sys)
        self.assertIn("上海", sys)
        self.assertIn("没有实时网络", sys)   # 诚实边界：不编新闻/精确天气

    def test_prompt_no_local_context_without_residence(self):
        char = CharacterRuntime("c", "维佳", {"core_traits": ["飒"]})   # 无现居
        sys = build_autonomy_prompt(char, 6)[0]["content"]
        self.assertNotIn("local_context", sys)

    def test_autonomous_block_injects_local_context(self):
        from micall.context.assembler import _autonomous_block
        block = _autonomous_block(AutonomousState(mood="还行", local_context="上海入秋，早晚凉"))
        self.assertIn("上海入秋，早晚凉", block)
        self.assertIn("当家常", block)             # 框成「可自然聊起来」
        self.assertIn("别假设 TA 也在这座城", block)  # 守卫：别替用户安地点


class TestEngine(unittest.TestCase):
    def test_advance_persists_per_character(self):
        repo = InMemoryRepository()
        state = {"mood": "话比平时多", "recent_experience": "看了场喜欢的演出", "energy": "还行"}
        engine = AutonomyEngine(StubLLM([json.dumps(state, ensure_ascii=False)]), repo)
        char = CharacterRuntime("lin_wan", "林晚", {"core_traits": ["温柔"]})

        out = asyncio.run(engine.advance(char, hours_since_last_call=72))
        self.assertEqual(out.recent_experience, "看了场喜欢的演出")
        # 持久化（per-character，独立于任何用户）
        self.assertEqual(repo.get_autonomous("lin_wan").mood, "话比平时多")
        # 不串到别的角色
        self.assertEqual(repo.get_autonomous("other"), AutonomousState())


if __name__ == "__main__":
    unittest.main()
