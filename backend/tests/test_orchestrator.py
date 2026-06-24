import asyncio
import unittest

from micall.config import load_config
from micall.context import CharacterRuntime, ContextAssembler
from micall.memory import InMemoryRepository
from micall.providers import StubLLM, StubTTS
from micall.session import CallSession


def _make_session(emit, llm=None):
    config = load_config()
    char = CharacterRuntime("lin_wan", "林晚", {"core_traits": ["温柔"]},
                            emotion_map={"tender": "gentle"})
    repo = InMemoryRepository()
    assembler = ContextAssembler(char, profile=repo.get_profile("u", "lin_wan"), memory=repo)
    return CallSession(
        config=config, emit=emit,
        llm=llm or StubLLM(["[emotion:tender] 嗯，我在听。今天过得怎么样？"]),
        tts=StubTTS(), assembler=assembler,
        character_id="lin_wan", scenario="heart", remaining_seconds=30, voice_id="v1",
    )


class TestStripActions(unittest.TestCase):
    def test_strip_stage_directions(self):
        from micall.session.orchestrator import _strip_actions
        self.assertEqual(_strip_actions("（轻声笑）不过这个嘛，我可不能告诉你。"), "不过这个嘛，我可不能告诉你。")
        self.assertEqual(_strip_actions("(smiles) hi"), "hi")
        self.assertEqual(_strip_actions("（歪着头，眨眨眼睛）"), "")  # 整句都是动作 → 空


class TestFiller(unittest.TestCase):
    def test_filler_detection(self):
        from micall.session.orchestrator import _is_filler
        # 纯语气词/backchannel（含重复、带标点）→ 非实质（回声/呼吸常被识成这些，老误打断）。
        for x in ("嗯", "嗯嗯", "嗯。", "啊", "哦哦", "嗯哼", "  唉 ", "呃…"):
            self.assertTrue(_is_filler(x), x)
        # 带实义词 → 实质，照常处理（哪怕以语气词开头）。
        for x in ("嗯我觉得", "累了", "今天好烦", "嗯，对的呀好的"):
            self.assertFalse(_is_filler(x), x)


class TestEchoGuard(unittest.TestCase):
    """AI 自己的声音回灌麦克风 → 不该被当成用户说话（防自己断/凭空冒话/重复『你好』）。"""

    def _sess(self):
        async def emit(ev):
            pass
        return _make_session(emit)

    def test_substring_echo_caught_across_whole_window(self):
        import time
        s = self._sess()
        s._ai_said = "你好呀，今天过得怎么样"
        s._audio_until = time.monotonic() - 0.3      # 音频刚播完（仍在拖尾窗内）
        self.assertTrue(s._looks_like_echo("你好呀"))  # 原话子串 → 高置信回声
        self.assertTrue(s._looks_like_echo("今天过得怎么样"))

    def test_fuzzy_overlap_only_while_playing(self):
        import time
        s = self._sess()
        s._ai_said = "我在这儿陪着你呢"
        # 播放中：字打乱但几乎都来自 AI 原话 → 模糊重叠判回声
        s._audio_until = time.monotonic() + 5.0
        self.assertTrue(s._looks_like_echo("陪着你在这儿"))
        # 播完进拖尾窗：模糊重叠不再判回声（避免误杀附和式真回复），只认子串
        s._audio_until = time.monotonic() - 0.5
        self.assertFalse(s._looks_like_echo("陪着你在这儿"))

    def test_window_expires(self):
        import time
        s = self._sess()
        s._ai_said = "你好呀"
        s._audio_until = time.monotonic() - 999     # 远超拖尾窗
        self.assertFalse(s._looks_like_echo("你好呀"))

    def test_real_reply_not_echo(self):
        import time
        s = self._sess()
        s._ai_said = "你今天想聊点什么"
        s._audio_until = time.monotonic() + 5.0
        self.assertFalse(s._looks_like_echo("我想去爬山"))   # 用词不同 → 不是回声
        self.assertFalse(s._looks_like_echo("", ))           # 空 → 不是
        s._ai_said = ""
        self.assertFalse(s._looks_like_echo("你好呀"))        # 没有基准 → 不是


class TestOrchestrator(unittest.TestCase):
    def test_turn_event_sequence(self):
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def run():
            s = _make_session(emit)
            await s.start()
            await s.on_user_text("今天有点累")
            await s.end()

        asyncio.run(run())
        types = [e["type"] for e in events]

        self.assertEqual(types[0], "connected")
        self.assertIn("ended", types)
        # 逐句情绪：每句一条 emotion 事件（驱动逐句切表情）；首句 tag 来自前缀，次句无标签→继承 tender。
        emo = [e for e in events if e["type"] == "emotion"]
        self.assertEqual(len(emo), 2)
        self.assertTrue(all(e["tag"] == "tender" for e in emo))
        # 回复两句 → 两条 AI 字幕（句子级切分）。
        ai = [e for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(len(ai), 2)
        # 用户字幕回显。
        self.assertTrue(any(e["type"] == "subtitle" and e["role"] == "user" for e in events))
        # 状态机：thinking → speaking → listening 都出现过。
        states = [e["phase"] for e in events if e["type"] == "state"]
        for p in ("thinking", "speaking", "listening"):
            self.assertIn(p, states)

    def test_per_sentence_emotion_and_clean_subtitle(self):
        # 逐句不同情绪 + 拟声：每句一条对应情绪事件；字幕是纯人话（拟声/标签不漏给用户）。
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        reply = "[emotion:sad]唉，(sighs)今天是不是又被骂了。[emotion:caring]别往心里去，啊。"

        async def run():
            s = _make_session(emit, llm=StubLLM([reply]))
            await s.start()
            await s.on_user_text("我今天好难受")
            await s.end()

        asyncio.run(run())
        emo = [e["tag"] for e in events if e["type"] == "emotion"]
        self.assertEqual(emo, ["sad", "caring"])          # 逐句情绪：先 sad 后 caring
        ai = [e["text"] for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(len(ai), 2)
        joined = "".join(ai)
        self.assertNotIn("(sighs)", joined)               # 拟声不进字幕
        self.assertNotIn("[emotion", joined)              # 情绪标签不进字幕
        self.assertIn("今天是不是又被骂了", joined)

    def test_speak_cuts_on_interrupt(self):
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def run():
            s = _make_session(emit)
            s._interrupt.set()
            spoke: list[str] = []
            job = {"emotion": "neutral", "speed": 1.0, "pitch": 0, "vol": 1.0, "tts": "你好。", "sub": "你好。"}
            await s._speak_job(job, None, spoke)
            return spoke

        spoke = asyncio.run(run())
        self.assertEqual(spoke, [])  # 熔断：已打断不发、不进上下文（§1.5 难点4）

    def test_interrupt_guard_when_idle(self):
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def run():
            s = _make_session(emit)
            await s.interrupt()  # 非 thinking/speaking → no-op

        asyncio.run(run())
        self.assertEqual([e for e in events if e["type"] == "interrupted"], [])

    def test_out_of_minutes_ends_call(self):
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def run():
            config = load_config()
            char = CharacterRuntime("lin_wan", "林晚", {})
            repo = InMemoryRepository()
            a = ContextAssembler(char, profile=repo.get_profile("u", "lin_wan"))
            s = CallSession(
                config=config, emit=emit, llm=StubLLM(), tts=StubTTS(), assembler=a,
                character_id="lin_wan", scenario="", remaining_seconds=1, voice_id="v",
            )
            # 直接驱动计费到耗尽，验证服务端权威结束（不依赖真实 sleep 节流）。
            for ev in s.billing.tick(1):
                await emit(ev)
            self.assertTrue(s.billing.exhausted)

        asyncio.run(run())
        self.assertIn("out_of_minutes", [e["type"] for e in events])


class TestScenarioPrompt(unittest.TestCase):
    """场景：短标签(记录/统计)与完整情境指令(喂 LLM)分离——修「选场景只把 key 传给 AI」的半残 bug。"""

    def _sess(self, **kw):
        async def emit(ev):
            pass
        config = load_config()
        char = CharacterRuntime("lin_wan", "林晚", {"core_traits": ["温柔"]}, emotion_map={"tender": "g"})
        repo = InMemoryRepository()
        assembler = ContextAssembler(char, profile=repo.get_profile("u", "lin_wan"), memory=repo)
        return CallSession(config=config, emit=emit, llm=StubLLM(["在"]), tts=StubTTS(),
                           assembler=assembler, character_id="lin_wan", remaining_seconds=30,
                           voice_id="v1", **kw)

    def test_prompt_feeds_llm_label_kept_for_record(self):
        s = self._sess(scenario="heart", scenario_prompt="我可能心情不好，请你耐心倾听、不说教。")
        self.assertEqual(s.scenario, "heart")                       # 记录用短标签
        # 喂 LLM 的 system 前缀注入的是完整指令，而非 key。
        sysmsg = s.assembler.build(character_id="lin_wan", scenario=s.scenario_prompt, history=[])[0]["content"]
        self.assertIn("耐心倾听", sysmsg)
        self.assertNotIn("当前情境：heart", sysmsg)

    def test_default_falls_back_to_label(self):
        s = self._sess(scenario="chat")                              # 没给 prompt → 回退标签（向后兼容）
        self.assertEqual(s.scenario_prompt, "chat")

    def test_set_scene_updates_prompt_not_label(self):
        s = self._sess(scenario="heart", scenario_prompt="原情境")
        s.set_scene("现在假装在海边散步")
        self.assertEqual(s.scenario_prompt, "现在假装在海边散步")   # LLM 情境换了
        self.assertEqual(s.scenario, "heart")                        # 记录标签不动（统计稳定）


if __name__ == "__main__":
    unittest.main()
