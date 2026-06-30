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


class TestInitialBalanceZero(unittest.TestCase):
    """初始余额为 0：start() 必须发 out_of_minutes 进终态，不能静默结束、不启动会话链路。"""

    def test_zero_balance_emits_out_of_minutes(self):
        import asyncio

        from micall.session.state import Phase
        events = []

        async def emit(ev):
            events.append(ev)

        config = load_config()
        char = CharacterRuntime("lin_wan", "林晚", {"core_traits": ["温柔"]})
        repo = InMemoryRepository()
        assembler = ContextAssembler(char, profile=repo.get_profile("u", "lin_wan"), memory=repo)
        s = CallSession(config=config, emit=emit, llm=StubLLM(["在"]), tts=StubTTS(),
                        assembler=assembler, character_id="lin_wan", scenario="",
                        remaining_seconds=0, voice_id="v")
        asyncio.run(s.start())
        types = [e.get("type") for e in events]
        self.assertIn("out_of_minutes", types)       # 前端据此进「余额不足」UI
        self.assertNotIn("connected", types)          # 未接通、未启动麦克风/LLM/TTS
        self.assertEqual(s.sm.phase, Phase.ENDED)     # 进终态
        self.assertIsNone(s._listen_task)             # 没起监听


class TestInterruptClosesEchoWindow(unittest.TestCase):
    def test_interrupt_resets_audio_until(self):
        # 打断即停播 → 立刻关回声守卫窗，否则 _audio_until 仍指向「本该播完的时刻」、
        # 用户打断后说的话会被 now<=_audio_until 的模糊重叠误判成回声、吞掉开头。
        import time as _t
        from micall.session.state import Phase
        events = []

        async def emit(ev):
            events.append(ev)

        s = _make_session(emit)
        s.sm.phase = Phase.SPEAKING               # 打断只在 THINKING/SPEAKING 生效
        s._audio_until = _t.monotonic() + 100     # 模拟 AI 正在播：回声窗推到未来
        asyncio.run(s.interrupt())
        self.assertLessEqual(s._audio_until, _t.monotonic())   # 已关回声窗
        self.assertTrue(any(e.get("type") == "interrupted" for e in events))


class TestVariedOpening(unittest.TestCase):
    def test_opening_varies_each_call(self):
        # 修「每次开头都重复一样的话」：每通随机叠一个开场角度 + 反重复要求。
        from micall.session.orchestrator import _varied_opening, _OPENING_ANGLES
        self.assertGreaterEqual(len(set(_OPENING_ANGLES)), 4)        # 多个不同角度可选
        base = "（开场基础指令）"
        outs = {_varied_opening(base) for _ in range(60)}
        self.assertGreater(len(outs), 1)                            # 多次调用产出不止一种
        for o in outs:
            self.assertTrue(o.startswith(base))                     # 基础指令保留
            self.assertIn("不一样", o)                               # 反重复要求在
            self.assertTrue(any(ang in o for ang in _OPENING_ANGLES))  # 含某个角度

    def test_memory_callback_opening_when_thread_exists(self):
        # 留存杠杆：有「未了的线头」时多半用记忆回扣开场（最强「你还记得我」），但不是每通（仍变化、防跨通复读）。
        from micall.session.orchestrator import _varied_opening
        base = "（开场）"
        # 无线头(默认)：绝不出现记忆回扣角度
        self.assertTrue(all("追一句上次没聊完" not in _varied_opening(base, prefer_memory=False) for _ in range(40)))
        # 有线头：会出现记忆回扣，但既不是 0% 也不是 100%（约一半 → 经常被记着、又不套路化）
        hits = sum("追一句上次没聊完" in _varied_opening(base, prefer_memory=True) for _ in range(200))
        self.assertTrue(0 < hits < 200)

    def test_scene_opening_drops_casual_angles(self):
        # 有具体情境（模拟面试/哄睡…）：开场由情境定，绝不叠"扯天气/换个场景起头"的随聊角度
        # （它们会和"顺着情境直接进入"自相矛盾，是开场不丝滑的根）。
        from micall.session.orchestrator import _varied_opening, _OPENING_ANGLES
        base = "（开场基础指令）"
        for _ in range(60):
            o = _varied_opening(base, has_scene=True)
            self.assertTrue(o.startswith(base))                       # 基础指令保留
            self.assertFalse(any(ang in o for ang in _OPENING_ANGLES))  # 不叠任何随聊角度
            self.assertNotIn("同一个场景起头", o)                      # 不再要求"换个场景"（情境要每通稳定地进）
        # 有线头时仍可记忆回扣，但顺着情境带出来、不跳出场景
        hits = sum("追一句上次没聊完" in _varied_opening(base, prefer_memory=True, has_scene=True) for _ in range(200))
        self.assertTrue(0 < hits < 200)
        self.assertTrue(all("别跳出场景" in o for o in
                            [_varied_opening(base, prefer_memory=True, has_scene=True) for _ in range(200)]
                            if "追一句上次没聊完" in o))


class TestFiller(unittest.TestCase):
    def test_filler_detection(self):
        from micall.session.orchestrator import _is_filler
        # 纯语气词/backchannel（含重复、带标点）→ 非实质（回声/呼吸常被识成这些，老误打断）。
        for x in ("嗯", "嗯嗯", "嗯。", "啊", "哦哦", "嗯哼", "  唉 ", "呃…"):
            self.assertTrue(_is_filler(x), x)
        # 带实义词 → 实质，照常处理（哪怕以语气词开头）。
        for x in ("嗯我觉得", "累了", "今天好烦", "嗯，对的呀好的"):
            self.assertFalse(_is_filler(x), x)


class TestLaughter(unittest.TestCase):
    def test_laughter_detection(self):
        from micall.session.orchestrator import _is_laughter
        # 纯笑声（≥2 字，含重复/标点）→ True：AI 说话时用户笑一声是捧场，不该打断她。
        for x in ("哈哈", "哈哈哈", "嘻嘻", "嘿嘿", "呵呵", "哈哈！", "  嘻嘻 "):
            self.assertTrue(_is_laughter(x), x)
        # 单字「哈」不算笑（太短，可能是噪声碎片）；带实义词不是纯笑。
        for x in ("哈", "哈哈不错", "你太逗了", "笑死我了", ""):
            self.assertFalse(_is_laughter(x), x)


class TestAsrHallucination(unittest.TestCase):
    def test_drops_phantom_keeps_real(self):
        from micall.session.orchestrator import _is_asr_hallucination as h
        # ASR 静音/噪声幻听（英文字幕水印 + 中文点赞订阅水印）→ 丢弃（用户根本没说）。
        for x in ("Thank you.YesYes.", "Thank you.", "Yes.", "you", "Bye.",
                  "Thank you for watching.", "Please subscribe.", "YesYes", "hmm uh um",
                  "请不吝点赞、订阅、转发、打赏，支持明镜与点点栏目", "谢谢观看", "  "):
            self.assertTrue(h(x), x)
        # 真说话（中文，或含实词的英文）→ 放行，不误伤。
        for x in ("你听过大海这首歌吗", "好的", "广告电话", "我没事",
                  "yes I think so is great", "ok let's go to the park tomorrow", "谢谢"):
            self.assertFalse(h(x), x)


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

    def test_two_char_substring_is_echo(self):
        # 「2字命中」实验已撤回（用户要求调回 3 字）：2 字若是 AI 原话子串 → 仍判回声（防 AI 自己声音回灌当插话）。
        import time
        s = self._sess()
        s._ai_said = "哎你问对人了"
        s._audio_until = time.monotonic() - 0.3            # 拖尾窗（AI 已说完）
        self.assertTrue(s._looks_like_echo("对人"))         # 2 字子串 = 回声（任何窗口）
        self.assertTrue(s._looks_like_echo("你问"))

    def test_bargein_min_chars_aec_is_3(self):
        # 「调整回去 3 个字」：AI 说话时要 3 字才算真打断（2 字多是 AI 自己声音回灌的碎片→认 2 字会自我打断/卡住）。
        self.assertEqual(self._sess()._bargein_min_chars_aec, 3)

    def test_echo_overlap_default_068(self):
        # 模糊重叠门槛默认 0.68（越高越不误杀顺着话题、与 AI 用词重合的真用户话）
        self.assertEqual(self._sess()._echo_overlap, 0.68)


class _MaxTokensSpyLLM(StubLLM):
    """记录每次 stream() 收到的 max_tokens，用于验证开场轮用更短的上限。"""
    def __init__(self, replies=None):
        super().__init__(replies)
        self.caps: list[int] = []

    async def stream(self, messages, *, temperature=0.8, max_tokens=256, response_format=None):
        self.caps.append(max_tokens)
        async for ch in super().stream(messages, temperature=temperature,
                                       max_tokens=max_tokens, response_format=response_format):
            yield ch


class TestOpeningBrevity(unittest.TestCase):
    def test_opening_uses_smaller_cap_than_reply(self):
        # 开场期 ASR 抑制、用户打不断 → 开场必须短：开场轮的 max_tokens 比正常轮小。
        spy = _MaxTokensSpyLLM(["嗨，在呢。"])

        async def emit(ev):
            pass

        async def run():
            s = _make_session(emit, llm=spy)
            await s.start()
            await s._generate_turn("（开场）", opening=True)    # 开场轮
            await s._generate_turn("嗯", opening=False)         # 正常轮
            await s.end()
            return s

        s = asyncio.run(run())
        self.assertGreaterEqual(len(spy.caps), 2)
        self.assertEqual(spy.caps[0], s._opening_max_tokens)    # 开场用更短上限
        self.assertEqual(spy.caps[1], s._reply_max_tokens)      # 正常轮回到正常上限
        self.assertLess(s._opening_max_tokens, s._reply_max_tokens)

    def test_opening_directive_demands_one_substantive_sentence(self):
        # 开场指令：就一句，但【要有内容】——禁止敷衍成一个『哟？』把话甩回来（治「上来一个哟」）。
        s = _make_session(lambda ev: None)
        self.assertIn("一句", s._opening_directive)
        self.assertIn("哟", s._opening_directive)        # 明确点名禁止「哟？」这种空开场

    def test_opening_speaks_only_first_complete_sentence(self):
        # 修「话没说完」：开场只说【完整的第一句】就停 —— 多句开场只播第一句，
        # 且绝不把后面没说完的半句念出来（截图里「……我这人就是，风」那种）。
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        # 模型给了两句（第一句完整 + 第二句起了个头没结尾标点）→ 只应播第一句、丢掉残句。
        llm = StubLLM(["[emotion:tender]你好呀。我今天路过河边看见个小孩"])

        async def run():
            s = _make_session(emit, llm=llm)
            await s.start()
            events.clear()                       # 只看开场轮的事件
            await s._generate_turn("（开场）", opening=True)
            await s.end()

        asyncio.run(run())
        ai = [e["text"] for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(len(ai), 1)             # 只说一句
        self.assertIn("你好呀", ai[0])
        self.assertNotIn("路过河边", " ".join(ai))   # 没说完的下半句没被念出来

    def test_normal_turn_still_multi_sentence(self):
        # 正常对话可多句（别误伤正常回合）：默认上限 2 句，两句都在。
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        llm = StubLLM(["[emotion:tender]嗯，我在听。今天过得怎么样？"])

        async def run():
            s = _make_session(emit, llm=llm)
            await s.start()
            events.clear()
            await s._generate_turn("我有点累", opening=False)
            await s.end()

        asyncio.run(run())
        ai = [e["text"] for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(len(ai), 2)             # 正常轮两句都在

    def test_normal_turn_capped_at_max_sentences(self):
        # 治「太长/越说越编」：正常轮封顶 _reply_max_sentences（默认2）句，多的不再起、干净停在句子边界。
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        llm = StubLLM(["[emotion:tender]第一句在这里。第二句也在这里。第三句不该出现。"])

        async def run():
            s = _make_session(emit, llm=llm)
            await s.start()
            events.clear()
            await s._generate_turn("随便说点", opening=False)
            await s.end()
            return s

        s = asyncio.run(run())
        ai = [e["text"] for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(len(ai), s._reply_max_sentences)       # 只说到上限句数
        self.assertNotIn("第三句", " ".join(ai))                 # 超出的句子没出现

    def test_half_sentence_fragment_not_spoken(self):
        # 治「说到一半不说了」：被 token 上限拦腰切断的半句（无句末标点、还挺长）→ 绝不念出来。
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        # 一句完整 + 一截被切断的半句（没有句末标点）
        llm = StubLLM(["[emotion:tender]这句是完整的。这后半截被切了没有句末"])

        async def run():
            s = _make_session(emit, llm=llm)
            await s.start()
            events.clear()
            await s._generate_turn("嗯", opening=False)
            await s.end()

        asyncio.run(run())
        ai = [e["text"] for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(len(ai), 1)
        self.assertIn("这句是完整的", ai[0])
        self.assertNotIn("被切了", " ".join(ai))                 # 半句残尾被丢弃

    def test_short_clean_tail_kept(self):
        # 别误伤：短而干净的收口（像「你呢」没加标点）仍要说出来，不能当半句丢了。
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        llm = StubLLM(["[emotion:tender]我也刚起来。你呢"])

        async def run():
            s = _make_session(emit, llm=llm)
            await s.start()
            events.clear()
            await s._generate_turn("早", opening=False)
            await s.end()

        asyncio.run(run())
        ai = [e["text"] for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertIn("你呢", " ".join(ai))                      # 短收口保留


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

    def test_start_does_not_open_until_ready(self):
        """start() 本身不让 AI 开口——开场改由前端 ready(begin_conversation) 触发（拨通先把 RTC 连好再开口）。"""
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def run():
            s = _make_session(emit)
            await s.start()
            await asyncio.sleep(0)        # 让任何被误触发的任务有机会跑
            await s.end()
            return s

        s = asyncio.run(run())
        self.assertIsNone(s._greet_task)             # start 没起开场任务
        self.assertFalse(s._greeted)                 # 未开过口
        ai = [e for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        self.assertEqual(ai, [])                     # start 后没有 AI 主动开场

    def test_ready_triggers_opening_speaks_first(self):
        """收到 ready(begin_conversation) → AI 主动开口；不伪造 user 字幕、不把指令写进 history；开场期抑制 ASR。"""
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        holder: dict = {}

        async def run():
            s = _make_session(emit)
            holder["s"] = s
            await s.start()
            s.begin_conversation()       # 前端「传输就绪」→ 触发开场（异步 create_task）
            if s._greet_task:
                await s._greet_task
            await s.end()

        asyncio.run(run())
        s = holder["s"]
        ai = [e for e in events if e["type"] == "subtitle" and e["role"] == "ai"]
        user_subs = [e for e in events if e["type"] == "subtitle" and e["role"] == "user"]
        self.assertGreaterEqual(len(ai), 1)          # AI 主动开了口
        self.assertEqual(user_subs, [])              # 开场不是用户说的 → 不伪造用户字幕
        self.assertFalse(s._opening_active)          # 开场结束标志已复位
        # 开场指令只临时喂 LLM、不入 history：history 里没有 user，只有 AI 开场回复。
        self.assertTrue(all(m["role"] != "user" for m in s.history))
        self.assertTrue(any(m["role"] == "assistant" for m in s.history))

    def test_begin_conversation_idempotent_and_safe_after_end(self):
        """begin_conversation 一次性（_greeted 守卫）；会话已结束再调安全 no-op。"""
        async def emit(ev):
            pass

        async def run():
            s = _make_session(emit)
            await s.start()
            s.begin_conversation()
            first = s._greet_task
            s.begin_conversation()           # 二次：应被 _greeted 守卫挡掉，不另起任务
            self.assertIs(s._greet_task, first)
            if s._greet_task:
                await s._greet_task
            await s.end()
            s.begin_conversation()           # 已结束：安全 no-op
            return s

        s = asyncio.run(run())
        self.assertTrue(s._greeted)

    def test_opening_yields_when_user_speaks_first(self):
        """用户抢先开口：开场让位，不插一条多余的开场轮（靠 history/phase 守卫）。"""
        events: list[dict] = []

        async def emit(ev):
            events.append(ev)

        async def run():
            s = _make_session(emit)
            await s.start()
            await s.on_user_text("我先说")       # 抢在开场任务前拿到 _turn_lock
            s.begin_conversation()
            if s._greet_task:
                await s._greet_task             # 开场任务此时应因 history 非空而直接返回
            await s.end()
            return s

        s = asyncio.run(run())
        # 只应有一轮（用户那轮）：恰好一条 user 字幕；history 第一条是 user（不是 AI 开场）。
        user_subs = [e for e in events if e["type"] == "subtitle" and e["role"] == "user"]
        self.assertEqual(len(user_subs), 1)
        self.assertEqual(s.history[0]["role"], "user")

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


class TestInCallWindowAndReplyCap(unittest.TestCase):
    """通话内滑窗与回复上限：长聊提速（越聊越卡的修复）——窗口由 incall_max_turns 控、可调；回复上限收成语音级。"""

    async def _emit(self, ev):
        pass

    def test_trim_honors_incall_max_turns(self):
        s = _make_session(self._emit)
        s._incall_max_turns = 6                                   # 旋钮可调
        s.history = [{"role": "user", "content": str(i)} for i in range(50)]
        s._trim_history()
        self.assertEqual(len(s.history), 6)                      # 收到窗口大小
        self.assertEqual(s.history[-1]["content"], "49")        # 保留最近的
        self.assertEqual(s.history[0]["content"], "44")

    def test_defaults_are_voice_sane(self):
        # 锁定默认值的「意图」而非具体数字：窗口不再是 30（长聊会卡）、回复上限不再是 2048（会长篇大论）。
        s = _make_session(self._emit)
        self.assertLessEqual(s._incall_max_turns, 24)
        self.assertGreaterEqual(s._incall_max_turns, 2)
        self.assertLessEqual(s._reply_max_tokens, 600)


if __name__ == "__main__":
    unittest.main()
