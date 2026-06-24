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

    def test_stripper_bare_tag_streaming(self):
        s = EmotionStripper()
        out = "".join(s.feed(c) for c in "[caring]下午四点多啦。") + s.flush()
        self.assertEqual(s.tag, "caring")
        self.assertEqual(out, "下午四点多啦。")   # bare 标签不漏进 TTS/字幕

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


if __name__ == "__main__":
    unittest.main()
