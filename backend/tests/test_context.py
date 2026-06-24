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

    def test_reset_memory_clears_facts_and_profile(self):
        r = InMemoryRepository()
        r.add_fact("u", "lin_wan", "养了一只猫叫团子")
        p = r.get_profile("u", "lin_wan"); p.next_strategy = "接面试线头"; r.save_profile(p)
        self.assertTrue(r.has_facts("u", "lin_wan"))
        r.reset_memory("u", "lin_wan")                       # 前端「重置记忆」
        self.assertFalse(r.has_facts("u", "lin_wan"))         # 事实层清空
        self.assertEqual(r.recall("u", "lin_wan", "猫", top_k=5), [])
        self.assertEqual(r.get_profile("u", "lin_wan").next_strategy, "")  # 理解层清空（回到空画像）

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
        self.assertEqual(msgs[-1]["role"], "user")     # L4 滑窗（末轮 user 会折进时间/记忆前缀）
        self.assertTrue(msgs[-1]["content"].endswith("在吗"))
        self.assertIn("现实时间", msgs[-1]["content"])   # 时间观念每轮注入末轮 user

    def test_identity_injected_into_persona(self):
        # AI 要知道自己的基本资料（性别/年龄/外貌/生日），否则被问就不知道。
        char = CharacterRuntime.from_spec({
            "identity": {"character_id": "x", "name": "苏窈", "gender": "女", "age": 23,
                         "appearance": "齐肩微卷发", "nationality": "中国",
                         "profile": {"birthday": "2003-09-30", "height_cm": 160}},
            "persona": {"core_traits": ["俏皮"]},
        })
        a = ContextAssembler(char)
        sysmsg = a.build(character_id="x", scenario="", history=[{"role": "user", "content": "你多大"}])[0]["content"]
        self.assertIn("23岁", sysmsg)
        self.assertIn("女", sysmsg)
        self.assertIn("2003-09-30", sysmsg)
        self.assertIn("齐肩微卷发", sysmsg)

    def test_window_trims_oldest(self):
        a = ContextAssembler(CharacterRuntime("c", "N", {}), budget_chars=300)
        hist = [{"role": "user", "content": "x" * 50} for _ in range(20)]
        msgs = a.build(character_id="c", scenario="", history=hist)
        self.assertLess(len(msgs), 1 + 20)            # system + 被裁后的少量滑窗
        self.assertTrue(msgs[-1]["content"].endswith(hist[-1]["content"]))  # 保留最近（末轮折进时间前缀）

    def test_time_awareness_injected(self):
        import datetime
        from micall.context.assembler import _now_line

        # 时段措辞按小时正确（深夜不会说成上午）。
        tz = datetime.timezone(datetime.timedelta(hours=8))
        deep = _now_line(datetime.datetime(2026, 6, 24, 23, 47, tzinfo=tz))
        self.assertIn("周三深夜", deep)            # 时段标签随小时正确（23 点 = 深夜，不会说成上午）
        self.assertIn("23:47", deep)
        morning = _now_line(datetime.datetime(2026, 6, 24, 8, 5, tzinfo=tz))
        self.assertIn("周三上午", morning)
        self.assertIn("08:05", morning)

    def test_time_line_when_no_last_user(self):
        # 开场白（无末轮 user）：时间作为一条 system 追加，至少让模型知道现在几点。
        a = ContextAssembler(self._char())
        msgs = a.build(character_id="lin_wan", scenario="", history=[])
        self.assertIn("现实时间", msgs[-1]["content"])
        self.assertEqual(msgs[-1]["role"], "system")

    def test_elapsed_line_buckets(self):
        from micall.context.assembler import _elapsed_line

        self.assertEqual(_elapsed_line(None), "")              # 首次通话：无间隔感
        self.assertIn("几分钟前刚通完话", _elapsed_line(120))    # 2 分钟 → 刚挂又拨
        self.assertIn("今天稍早", _elapsed_line(60 * 30))       # 半小时
        self.assertIn("昨天", _elapsed_line(3600 * 24))         # 一天
        self.assertIn("前天", _elapsed_line(3600 * 48))         # 两天
        self.assertIn("3 天", _elapsed_line(86400 * 3))         # 几天
        self.assertIn("周", _elapsed_line(86400 * 21))          # 三周
        self.assertIn("一个多月", _elapsed_line(86400 * 70))     # 很久

    def test_special_day_line(self):
        import datetime
        from micall.context.assembler import _special_day_line

        tz = datetime.timezone(datetime.timedelta(hours=8))
        self.assertIn("国庆节", _special_day_line(datetime.datetime(2026, 10, 1, 9, 0, tzinfo=tz)))  # 固定公历
        self.assertIn("春节", _special_day_line(datetime.datetime(2026, 2, 17, 9, 0, tzinfo=tz)))     # 2026 农历
        self.assertEqual(_special_day_line(datetime.datetime(2026, 6, 24, 9, 0, tzinfo=tz)), "")      # 平常日子无

    def test_seconds_since_last_call_roundtrip(self):
        r = InMemoryRepository()
        self.assertIsNone(r.seconds_since_last_call("u", "lin_wan"))   # 没通过话
        r.add_call("u", "lin_wan", "心情树洞", 120, "ended")
        secs = r.seconds_since_last_call("u", "lin_wan")
        self.assertIsNotNone(secs)
        self.assertLess(secs, 60)                                       # 刚写入，间隔很小
        self.assertIsNone(r.seconds_since_last_call("u", "other_char")) # 按角色隔离

    def test_human_context_injects_elapsed_and_festival(self):
        import datetime

        r = InMemoryRepository()
        r.add_call("u", "lin_wan", "", 60, "ended")          # 制造一次往次通话
        prof = UserProfile("u", "lin_wan")
        a = ContextAssembler(self._char(), profile=prof, memory=r)
        tz = datetime.timezone(datetime.timedelta(hours=8))
        human = a._human_context("lin_wan", datetime.datetime(2026, 10, 1, 9, 0, tzinfo=tz))
        self.assertIn("现实时间", human)     # 时间
        self.assertIn("刚通完话", human)      # 间隔感（刚 add_call）
        self.assertIn("国庆节", human)        # 节日应景

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
