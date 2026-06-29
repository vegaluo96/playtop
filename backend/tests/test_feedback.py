"""通话评价 → 校准闭环：派生纯函数 + repo 落库 + assembler 注入。"""
import unittest

from micall.context import CharacterRuntime, ContextAssembler
from micall.memory import InMemoryRepository
from micall.memory.feedback import calibration_from_feedback


class TestCalibrationFromFeedback(unittest.TestCase):
    def test_invalid_rating_returns_empty(self):
        self.assertEqual(calibration_from_feedback(0, []), "")
        self.assertEqual(calibration_from_feedback(6, []), "")
        self.assertEqual(calibration_from_feedback(None, []), "")
        self.assertEqual(calibration_from_feedback("x", []), "")  # type: ignore[arg-type]

    def test_high_rating_keeps_state(self):
        s = calibration_from_feedback(5, ["很温暖", "聊得开心"])
        self.assertIn("满意", s)
        self.assertIn("保持", s)
        self.assertIn("温暖", s)        # 正向标签被带出
        self.assertIn("开心", s)

    def test_low_rating_corrects(self):
        s = calibration_from_feedback(1, ["答非所问", "反应慢"])
        self.assertIn("不太满意", s)
        self.assertTrue("贴着" in s or "干脆" in s)   # 给出可执行的纠偏
        self.assertIn("答非所问", s)

    def test_mid_rating(self):
        s = calibration_from_feedback(3, ["反应慢"])
        self.assertIn("一般", s)
        self.assertIn("跟手", s)        # 负向标签映射短语

    def test_unknown_tags_ignored(self):
        # 前端日后增减标签：未知标签不炸、只是不进校准
        s = calibration_from_feedback(5, ["天外飞仙"])
        self.assertIn("满意", s)


class TestRecordCallFeedback(unittest.TestCase):
    def test_record_writes_calibration_to_profile(self):
        repo = InMemoryRepository()
        note = repo.record_call_feedback("u1", "vega", 2, ["反应慢"])
        self.assertTrue(note)
        prof = repo.get_profile("u1", "vega")
        self.assertEqual(prof.reply_calibration, note)
        self.assertIn("不太满意", prof.reply_calibration)

    def test_invalid_rating_no_write(self):
        repo = InMemoryRepository()
        note = repo.record_call_feedback("u1", "vega", 0, [])
        self.assertEqual(note, "")
        self.assertEqual(repo.get_profile("u1", "vega").reply_calibration, "")

    def test_latest_rating_overwrites(self):
        repo = InMemoryRepository()
        repo.record_call_feedback("u1", "vega", 1, ["答非所问"])
        repo.record_call_feedback("u1", "vega", 5, ["很温暖"])
        prof = repo.get_profile("u1", "vega")
        self.assertIn("满意", prof.reply_calibration)   # 最新一次评价覆盖

    def test_isolated_per_user_and_char(self):
        repo = InMemoryRepository()
        repo.record_call_feedback("u1", "vega", 5, ["很温暖"])
        self.assertEqual(repo.get_profile("u2", "vega").reply_calibration, "")   # 别的用户不串
        self.assertEqual(repo.get_profile("u1", "tuan_zi").reply_calibration, "")  # 别的角色不串


class TestAssemblerInjectsCalibration(unittest.TestCase):
    def test_calibration_appears_in_prefix(self):
        repo = InMemoryRepository()
        repo.record_call_feedback("u1", "vega", 1, ["答非所问"])
        char = CharacterRuntime("vega", "维佳", {"core_traits": ["直接"]})
        assembler = ContextAssembler(char, profile=repo.get_profile("u1", "vega"), memory=repo)
        prefix = assembler.prefix("")
        self.assertIn("据 TA 上次的当面反馈校准", prefix)
        self.assertIn("不太满意", prefix)

    def test_no_calibration_no_injection(self):
        repo = InMemoryRepository()
        char = CharacterRuntime("vega", "维佳", {"core_traits": ["直接"]})
        assembler = ContextAssembler(char, profile=repo.get_profile("u1", "vega"), memory=repo)
        self.assertNotIn("据 TA 上次的当面反馈校准", assembler.prefix(""))


if __name__ == "__main__":
    unittest.main()
