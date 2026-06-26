"""音色自定义匹配 —— 描述 → 库内 voice_id。LLM 不可用时启发式兜底，永远给库内合法音色。"""
import unittest

from micall.server.voice_match import _extract_id, _heuristic_match, match_voice
from micall.server.voice_library import voice_ids


class TestVoiceMatch(unittest.TestCase):
    def test_extract_id_from_noisy_llm_output(self):
        self.assertEqual(_extract_id("我选 female-yujie 这个最贴近"), "female-yujie")
        self.assertEqual(_extract_id("voice_id: male-qn-badao-jingpin"), "male-qn-badao-jingpin")
        self.assertEqual(_extract_id("就用「御姐」吧"), "female-yujie")   # 退中文名
        self.assertEqual(_extract_id("库里没有这个"), "")                  # 命不中 → 空

    def test_heuristic_always_returns_valid_library_voice(self):
        ids = voice_ids()
        for desc in ("温柔的成熟女声", "低沉磁性的大叔", "甜美的少女音", "可爱的小孩子声音",
                     "御姐范儿", "霸道少爷", "", "asdfgh 乱写"):
            v = _heuristic_match(desc)
            self.assertIn(v["voice_id"], ids, desc)       # 永远是库内合法音色
            self.assertEqual(v["by"], "heuristic")

    def test_heuristic_gender_and_keyword(self):
        self.assertEqual(_heuristic_match("可爱的小孩子声音")["group"], "童声")
        self.assertEqual(_heuristic_match("我想要御姐音")["gender"], "女声")
        self.assertEqual(_heuristic_match("低沉磁性的大叔")["gender"], "男声")

    def test_match_voice_entry_never_raises_and_is_valid(self):
        # 无 LLM 配置时 make_llm 回退 Stub → 抠不出 id → 启发式兜底；整体不抛、结果合法。
        v = match_voice("深夜电台那种温柔御姐声")
        self.assertIn(v["voice_id"], voice_ids())
        self.assertIn("name", v)


if __name__ == "__main__":
    unittest.main()
