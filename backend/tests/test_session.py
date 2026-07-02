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
        self.assertGreater(prosody_for("excited")[1], prosody_for("happy")[1])  # 兴奋比开心更快
        # pitch 一律 0——改音高=换音色=「像换了个人」，情绪只靠枚举+语速+拟声。
        self.assertTrue(all(prosody_for(e)[2] == 0 for e in ("sad", "happy", "excited", "playful", "angry")))
        self.assertEqual(prosody_for("没这个情绪"), prosody_for("neutral"))  # 未知 → 中性兜底

    def test_emotion_mode_gates_strong_emotions(self):
        # 治「音色一句一变」：gentle(默认)压掉强情绪(angry/fearful/disgusted/surprised)、保温和三档；
        # off 全砍；full 不动。只砍 MiniMax 情绪枚举，speed/vol/拟声不受影响。
        from micall.providers.minimax_tts import _gate_emotion
        for strong in ("angry", "fearful", "disgusted", "surprised"):
            self.assertEqual(_gate_emotion(strong, "gentle"), "")     # 强情绪 → 压成韵律-only
        for soft in ("happy", "sad", "neutral"):
            self.assertEqual(_gate_emotion(soft, "gentle"), soft)     # 温和情绪保留
        for e in ("happy", "angry", "surprised"):
            self.assertEqual(_gate_emotion(e, "off"), "")             # off 一律去情绪
            self.assertEqual(_gate_emotion(e, "full"), e)             # full 旧行为不动
        self.assertEqual(_gate_emotion("", "gentle"), "")            # 本就无情绪 → 不动
        self.assertEqual(_gate_emotion("angry", "怪档位"), "")        # 未知档位保守按 gentle 收敛

    def test_prosody_emotion_map_reroutes_per_character(self):
        # 角色卡 voice.emotion_map 把同一情绪标签按本角色重路由到不同韵律档（vega: caring→sad 念得低沉）。
        from micall.session.emotion import prosody_for
        vega_map = {"caring": "sad", "tender": "gentle"}
        self.assertEqual(prosody_for("caring", vega_map), prosody_for("sad"))     # caring 被路由成 sad
        self.assertEqual(prosody_for("tender", vega_map), prosody_for("gentle"))
        # 没配 / 未知映射键 → 按原标签，等于现状（绝不变差）。
        self.assertEqual(prosody_for("happy", vega_map), prosody_for("happy"))
        self.assertEqual(prosody_for("caring", {"caring": "不存在的档"}), prosody_for("caring"))
        self.assertEqual(prosody_for("caring", None), prosody_for("caring"))

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

    def test_bracketed_multiword_interjection(self):
        from micall.session.emotion import clean_for_subtitle, clean_for_tts
        # 模型写的方括号多词拟声 [laughs softly]：字幕要去掉（实测漏到字幕），TTS 转成真笑。
        self.assertEqual(clean_for_subtitle("笑一下听吧。[laughs softly]刚才挂完电话。"), "笑一下听吧。刚才挂完电话。")
        self.assertEqual(clean_for_tts("笑一下听吧。[laughs softly]刚才挂完电话。"), "笑一下听吧。(laughs)刚才挂完电话。")
        self.assertEqual(clean_for_tts("唉。[sighs]别这样"), "唉。(sighs)别这样")
        self.assertEqual(clean_for_subtitle("[8:30]该起床了"), "[8:30]该起床了")  # 数字开头(时间)不误伤

    def test_paren_stage_direction_with_comma(self):
        from micall.session.emotion import clean_for_subtitle, clean_for_tts
        # 实测 bug：字幕里冒出「(sighs lightly, playful)」。根因是旧 _EN_PAREN 不含逗号 → 多词带逗号的
        # 表演提示漏过。字幕必须全去；TTS 按首词归一为单拟声标签 (sighs)，不把整串英文念出来。
        s = "(sighs lightly, playful) 你啊，说话总爱留半句。"
        self.assertEqual(clean_for_subtitle(s), "你啊，说话总爱留半句。")
        self.assertEqual(clean_for_tts(s), "(sighs) 你啊，说话总爱留半句。")
        # 首词非拟声的纯舞台说明：字幕与 TTS 都去掉（别让 MiniMax 念「thinking deeply」）。
        self.assertEqual(clean_for_subtitle("(thinking deeply) 让我想想。"), "让我想想。")
        self.assertEqual(clean_for_tts("(thinking deeply) 让我想想。"), "让我想想。")

    def test_bracket_stage_direction_with_cjk_comma(self):
        from micall.session.emotion import clean_for_subtitle, clean_for_tts
        # 实测 bug 再现：方括号里带全角逗号+中文的表演提示「[sighs，有点无奈地笑了]」整条漏进字幕。
        # 根因是旧 _ALL_EMOTION_TAGS 内部字符类不含全角标点，被 ， 截断。字幕全去；TTS 转成 (sighs)。
        s = "[sighs，有点无奈地笑了] 你真是......"
        self.assertEqual(clean_for_subtitle(s), "你真是......")
        self.assertEqual(clean_for_tts(s), "(sighs) 你真是......")
        # 时间形态 [8:30] 仍不误伤（数字开头不当标签）。
        self.assertEqual(clean_for_subtitle("[8:30]该起床了"), "[8:30]该起床了")

    def test_multiline_fullwidth_paren_stage_direction(self):
        from micall.session.emotion import clean_for_subtitle, clean_for_tts
        from micall.session.orchestrator import _take_first_sentence
        # 实测 bug（截图）：「（轻笑了声，身体往后靠了靠，手指在桌上无意识地敲了两下。）莫比乌斯环……有意思。」
        # 全角括号旁白内含句号 → 旧切句器把它拦腰切成两句、各自括号不配对、漏进字幕/被念。
        full = "（轻笑了声，身体往后靠了靠，手指在桌上无意识地敲了两下。）莫比乌斯环……有意思。"
        # ① 切句器括号感知：整段旁白随后面正经话在闭括号后才一起切，旁白不被句号断开。
        head, rest = _take_first_sentence(full)
        self.assertEqual(rest, "")
        self.assertEqual(clean_for_subtitle(head), "莫比乌斯环……有意思。")
        # ② 整串直接清洗（配对全角旁白）也对。
        self.assertEqual(clean_for_subtitle(full), "莫比乌斯环……有意思。")
        # ③ 即便仍被切碎成两半，清洗兜底：未闭合开符删到尾、孤立闭符清掉。
        self.assertEqual(clean_for_subtitle("（轻笑了声，身体往后靠了靠，手指在桌上无意识地敲了两下。"), "")
        self.assertEqual(clean_for_subtitle("）莫比乌斯环……有意思。"), "莫比乌斯环……有意思。")
        self.assertEqual(clean_for_tts("）莫比乌斯环……有意思。"), "莫比乌斯环……有意思。")
        # ④ 配对全角旁白照常全去（字幕 + TTS）。
        self.assertEqual(clean_for_subtitle("你好。（停顿）在吗？"), "你好。在吗？")

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
        # 明确被逗乐却没写「哈哈」→ 句尾补真笑（让支持拟声的音色笑出来）。
        self.assertEqual(humanize_for_tts("你太逗了", "playful"), "你太逗了(laughs)")
        self.assertEqual(humanize_for_tts("笑死我了", "happy"), "笑死我了(laughs)")
        self.assertNotIn("(laughs)", humanize_for_tts("今天天气不错", "happy"))  # 没逗乐标志不硬加


if __name__ == "__main__":
    unittest.main()
