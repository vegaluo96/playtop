"""_collapse_repeat：只折【整句翻倍】，绝不误伤合法叠词。
回归护栏——「谢谢/拜拜/看看/研究研究」曾被折成单字后在编排层当噪声丢弃，AI 对这些高频短语完全不回应。"""
import unittest

from micall.providers.bailian_asr import _collapse_repeat


class TestCollapseRepeat(unittest.TestCase):
    def test_two_char_reduplication_kept(self):
        # 最要命的一类：2 字叠词若折半 → 单字 → 编排层丢弃 → AI 不应答。必须原样保留。
        for w in ("谢谢", "拜拜", "看看", "妈妈", "试试", "走走"):
            self.assertEqual(_collapse_repeat(w), w)

    def test_four_char_reduplication_kept(self):
        # AABB/ABAB 叠词（研究研究=想一想）：前后半相同但仍是合法词，不折。
        for w in ("研究研究", "商量商量", "你好你好"):
            self.assertEqual(_collapse_repeat(w), w)

    def test_doubled_full_sentence_collapsed(self):
        # 真正要治的：整句被识别翻倍一遍（每半足够长）→ 折成一份。
        self.assertEqual(_collapse_repeat("我今天心情很好我今天心情很好"), "我今天心情很好")

    def test_space_separated_identical_collapsed(self):
        # 空白分隔的整词翻倍（含英文 bye bye）→ 折成一份。
        self.assertEqual(_collapse_repeat("好 好"), "好")
        self.assertEqual(_collapse_repeat("bye bye"), "bye")

    def test_normal_text_untouched(self):
        self.assertEqual(_collapse_repeat(""), "")
        self.assertEqual(_collapse_repeat("今天天气不错"), "今天天气不错")
        self.assertEqual(_collapse_repeat("我想你了"), "我想你了")


if __name__ == "__main__":
    unittest.main()
