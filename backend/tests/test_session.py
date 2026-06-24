import unittest

from micall.session import (
    BillingMeter,
    CallStateMachine,
    EmotionStripper,
    IllegalTransition,
    Phase,
    split_emotion,
)


class TestStateMachine(unittest.TestCase):
    def test_legal_flow(self):
        sm = CallStateMachine()
        for p in (Phase.CALLING, Phase.LISTENING, Phase.THINKING, Phase.SPEAKING, Phase.LISTENING):
            sm.to(p)
        self.assertEqual(sm.phase, Phase.LISTENING)

    def test_interrupt_skips_thinking(self):
        sm = CallStateMachine()
        for p in (Phase.CALLING, Phase.LISTENING, Phase.THINKING, Phase.SPEAKING):
            sm.to(p)
        self.assertTrue(sm.can(Phase.LISTENING))  # speaking → listening（打断）
        sm.to(Phase.LISTENING)
        self.assertEqual(sm.phase, Phase.LISTENING)

    def test_illegal_raises(self):
        sm = CallStateMachine()
        with self.assertRaises(IllegalTransition):
            sm.to(Phase.SPEAKING)  # idle 直跳 speaking 非法


class TestBilling(unittest.TestCase):
    def test_billing_low_and_exhaust(self):
        m = BillingMeter(3, low_threshold_seconds=2)
        t1 = [e["type"] for e in m.tick()]   # remaining 2 → low
        self.assertIn("billing", t1)
        self.assertIn("low_minutes", t1)
        m.tick()                              # remaining 1
        t3 = [e["type"] for e in m.tick()]    # remaining 0 → out
        self.assertIn("out_of_minutes", t3)
        self.assertTrue(m.exhausted)
        self.assertEqual(m.tick(), [])        # 耗尽后不再产出

    def test_low_warns_once(self):
        m = BillingMeter(5, low_threshold_seconds=4)
        warns = 0
        for _ in range(5):
            warns += sum(1 for e in m.tick() if e["type"] == "low_minutes")
        self.assertEqual(warns, 1)


class TestEmotion(unittest.TestCase):
    def test_split(self):
        self.assertEqual(split_emotion("[emotion:tender] 你好"), ("tender", "你好"))
        self.assertEqual(split_emotion("没有标签的回复"), ("neutral", "没有标签的回复"))
        # 模型常省略 key 直接吐 [caring]/[listening]（用户实测漏到字幕）——bare 标签也要剥掉。
        self.assertEqual(split_emotion("[caring]下午四点多啦。"), ("caring", "下午四点多啦。"))
        self.assertEqual(split_emotion("[listening]嗯，四点多。"), ("listening", "嗯，四点多。"))
        self.assertEqual(split_emotion("【tender】在呢"), ("tender", "在呢"))
        # 模型把 key 拼错（eomotion）仍带 :tag——不在固定 key 列表也要剥掉（用户实测 [eomotion:idle] 漏字幕）。
        self.assertEqual(split_emotion("[eomotion:idle] 嗯，我在呢。"), ("idle", "嗯，我在呢。"))
        self.assertEqual(split_emotion("[mood：平静]在的"), ("平静", "在的"))
        # 不误伤：开头不是括号标签的正常话原样返回（含开头是时间/数字的不剥）。
        self.assertEqual(split_emotion("[8:30]该起床了"), ("neutral", "[8:30]该起床了"))

    def test_stripper_bare_tag_streaming(self):
        s = EmotionStripper()
        out = "".join(s.feed(c) for c in "[caring]下午四点多啦。") + s.flush()
        self.assertEqual(s.tag, "caring")
        self.assertEqual(out, "下午四点多啦。")   # bare 标签不漏进 TTS/字幕

    def test_stripper_misspelled_key_streaming(self):
        # 用户实测：模型吐 [eomotion:idle]（拼错 key），逐 token 流式也要剥干净，不漏字幕。
        s = EmotionStripper()
        out = "".join(s.feed(c) for c in "[eomotion:idle] 嗯，我在呢。") + s.flush()
        self.assertEqual(s.tag, "idle")
        self.assertEqual(out, "嗯，我在呢。")

    def test_stripper_streaming(self):
        s = EmotionStripper()
        out = "".join(s.feed(tok) for tok in "[emotion:caring] 嗯，我在。")
        self.assertEqual(s.tag, "caring")
        self.assertEqual(out, "嗯，我在。")

    def test_stripper_no_tag_passthrough(self):
        s = EmotionStripper()
        out = "".join(s.feed(c) for c in "直接说话没有前缀") + s.flush()
        self.assertEqual(out, "直接说话没有前缀")
        self.assertEqual(s.tag, "neutral")


class TestSentenceEmotion(unittest.TestCase):
    """逐句情绪 + 韵律 + 拟声/停顿清洗：让 AI 说话带情绪、像真人。"""

    def test_prosody_presets(self):
        from micall.session.emotion import prosody_for
        self.assertLess(prosody_for("sad")[1], 1.0)        # 难过更慢
        self.assertLess(prosody_for("comfort")[1], prosody_for("sad")[1])  # 安慰比难过更慢
        self.assertGreater(prosody_for("happy")[1], 1.0)   # 开心更快
        self.assertGreater(prosody_for("excited")[2], 0)   # 兴奋音高更高
        self.assertEqual(prosody_for("没这个情绪"), prosody_for("neutral"))  # 未知 → 中性兜底

    def test_take_sentence_emotion_inherit(self):
        from micall.session.emotion import take_sentence_emotion
        self.assertEqual(take_sentence_emotion("[emotion:sad]难受", "neutral"), ("sad", "难受"))
        self.assertEqual(take_sentence_emotion("[happy]开心", "neutral"), ("happy", "开心"))  # bare 标签
        self.assertEqual(take_sentence_emotion("没标签的话", "tender"), ("tender", "没标签的话"))  # 继承

    def test_clean_for_tts_keeps_interjection_and_pause(self):
        from micall.session.emotion import clean_for_tts
        out = clean_for_tts("(sighs)唉 <#0.3#> 别难过。（叹气）")
        self.assertIn("(sighs)", out)     # 合法拟声标签：喂 TTS（会被读成声音）
        self.assertIn("<#0.3#>", out)     # 停顿标记保留
        self.assertNotIn("（叹气）", out)  # 中文旁白：去掉
        self.assertEqual(clean_for_tts("(blah)正文"), "正文")  # 非法英文括号当旁白去掉

    def test_clean_for_subtitle_strips_all_cues(self):
        from micall.session.emotion import clean_for_subtitle
        out = clean_for_subtitle("[emotion:sad](sighs)唉 <#0.3#> 别难过。")
        self.assertEqual(out, "唉 别难过。")   # 标签/拟声/停顿全去掉，只剩人话

    def test_humanize_text_to_real_sounds(self):
        from micall.session.emotion import humanize_for_tts
        # 正向情绪：文字「哈哈」→ (laughs)（让 TTS 真笑）。
        self.assertEqual(humanize_for_tts("哈哈，太逗了", "happy"), "(laughs)，太逗了")
        self.assertEqual(humanize_for_tts("嘻嘻你好坏", "playful"), "(laughs)你好坏")
        # 低落/温柔情绪：文字「唉」→ (sighs)（让 TTS 真叹气）。
        self.assertEqual(humanize_for_tts("唉，今天好累", "sad"), "(sighs)，今天好累")
        self.assertEqual(humanize_for_tts("唉唉别这样", "comfort"), "(sighs)别这样")
        # 不越界：开心时的「唉」不转叹气；难过时的「哈」不转笑。
        self.assertEqual(humanize_for_tts("哈哈", "sad"), "哈哈")
        self.assertEqual(humanize_for_tts("唉", "happy"), "唉")
        # 单个「哈」不是笑，不动。
        self.assertEqual(humanize_for_tts("哈", "happy"), "哈")


if __name__ == "__main__":
    unittest.main()
