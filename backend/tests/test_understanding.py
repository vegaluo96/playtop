import asyncio
import json
import unittest

from micall.context.models import UserProfile
from micall.memory import InMemoryRepository
from micall.offline import (
    UnderstandingEngine,
    extract_facts,
    merge_profile,
    parse_profile_update,
)
from micall.offline.understanding import _grounded_in_history
from micall.providers import StubLLM


class TestExtractFacts(unittest.TestCase):
    def test_only_user_turns(self):
        history = [
            {"role": "user", "content": "我在准备面试"},
            {"role": "assistant", "content": "加油"},
            {"role": "user", "content": "  养了只猫  "},
            {"role": "user", "content": ""},
        ]
        self.assertEqual(extract_facts(history), ["我在准备面试", "养了只猫"])

    def test_filters_trivial_backchannel(self):
        history = [
            {"role": "user", "content": "嗯嗯"},
            {"role": "user", "content": "哈哈哈"},
            {"role": "user", "content": "好的"},
            {"role": "user", "content": "我下周要去成都出差"},
            {"role": "user", "content": "哦"},
        ]
        # 纯语气词/笑声不入事实层，只留真有信息量的那句
        self.assertEqual(extract_facts(history), ["我下周要去成都出差"])


class TestGroundedVerify(unittest.TestCase):
    """信而核验：候选记忆必须能在真实对话里找到由头。user_only 用于「关于 TA 的事实」——
    角色在通话里凭空提到的实体（虚构『老周』）不能被当成 TA 的事实写库。"""

    def _hist(self):
        return [
            {"role": "user", "content": "我最近在学吉他"},
            {"role": "assistant", "content": "你上次提到的老周最近怎么样了"},   # 角色凭空造的实体
        ]

    def test_user_only_rejects_entity_only_said_by_character(self):
        # 「老周」只在角色台词里 → 关于 TA 的事实核验（user_only）应判查无实据。
        self.assertFalse(_grounded_in_history("TA 有个朋友叫老周", self._hist(), user_only=True))

    def test_user_only_accepts_entity_said_by_user(self):
        self.assertTrue(_grounded_in_history("TA 在学吉他", self._hist(), user_only=True))

    def test_full_history_accepts_shared_experience_from_either_speaker(self):
        # 共同经历按全程转写核验：角色真说出口的「老周」也是真发生过的对话事件。
        self.assertTrue(_grounded_in_history("聊到老周", self._hist()))

    def test_no_content_tokens_is_conservatively_kept(self):
        # 抠不出可判定内容词（单字/纯标点，无二元词）→ 保守判 True，不误删。
        self.assertTrue(_grounded_in_history("嗯", self._hist(), user_only=True))
        self.assertTrue(_grounded_in_history("。", self._hist(), user_only=True))


class TestCorrectionRemoval(unittest.TestCase):
    """写入规则升级：remove_facts 纠错删除——告别『增改不删』永久背着错记的事实。"""

    def _profile(self):
        p = UserProfile("u", "c")
        p.fact_profile = {"职业": "模特", "脚上小事": "磨破皮贴了创可贴", "所在地": "北京"}
        return p

    def test_remove_facts_deletes_corrected_keys(self):
        p = self._profile()
        merge_profile(p, {"remove_facts": ["职业", "创可贴"]})
        self.assertNotIn("职业", p.fact_profile)          # TA 说「我不是模特」→ 删
        self.assertNotIn("脚上小事", p.fact_profile)       # 值里含「创可贴」→ 删张冠李戴那条
        self.assertIn("所在地", p.fact_profile)            # 没被点名的保留

    def test_remove_then_merge_keeps_corrected_value(self):
        # 同键既在 remove_facts 又有更正值：先删后写 → 保住更正值，不被误删
        p = self._profile()
        merge_profile(p, {"remove_facts": ["所在地"], "fact_profile": {"所在地": "上海"}})
        self.assertEqual(p.fact_profile["所在地"], "上海")

    def test_remove_ignores_too_short_token(self):
        p = self._profile()
        merge_profile(p, {"remove_facts": ["猫"]})   # 1 字 token 不参与匹配，避免误删
        self.assertEqual(len(p.fact_profile), 3)

    def test_prompt_documents_remove_facts(self):
        from micall.offline.understanding import build_understanding_prompt
        system = build_understanding_prompt(UserProfile("u", "c"), [])[0]["content"]
        self.assertIn("remove_facts", system)


class TestSpeakerAttribution(unittest.TestCase):
    """防『角色把自己说的话当成用户的事』(脚上创可贴 bug)：转写区分说话人 + 铁律不张冠李戴。"""

    def test_transcript_labels_distinguish_speakers(self):
        from micall.offline.understanding import _speaker_label, build_understanding_prompt
        self.assertEqual(_speaker_label("user"), "对方(TA)")
        self.assertEqual(_speaker_label("assistant"), "角色本人")
        history = [
            {"role": "assistant", "content": "我今天跳舞脚磨破皮了，贴了创可贴"},
            {"role": "user", "content": "多喝热水"},
        ]
        msgs = build_understanding_prompt(UserProfile("u", "c"), history)
        user_msg = msgs[-1]["content"]
        # 转写里角色自己的话被标成「角色本人:」而非裸 assistant:，用户的标成「对方(TA):」
        self.assertIn("角色本人: 我今天跳舞脚磨破皮了", user_msg)
        self.assertIn("对方(TA): 多喝热水", user_msg)
        self.assertNotIn("assistant:", user_msg)

    def test_system_prompt_has_attribution_ironclad_rule(self):
        from micall.offline.understanding import build_understanding_prompt
        system = build_understanding_prompt(UserProfile("u", "c"), [])[0]["content"]
        self.assertIn("张冠李戴", system)
        self.assertIn("角色本人", system)
        self.assertIn("绝不能", system)


class TestParse(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_profile_update('{"next_strategy":"轻轻问"}')["next_strategy"], "轻轻问")

    def test_wrapped_json(self):
        raw = "好的，分析如下：\n{\"next_strategy\":\"接面试线头\"}\n以上。"
        self.assertEqual(parse_profile_update(raw)["next_strategy"], "接面试线头")

    def test_garbage_returns_empty(self):
        self.assertEqual(parse_profile_update("这里没有 JSON"), {})
        self.assertEqual(parse_profile_update("{坏的"), {})

    def test_trailing_text_with_brace(self):
        # 正文里出现 } —— 旧法 index..rindex 会连标点截进来解析失败；raw_decode 只取第一个完整对象。
        raw = '{"next_strategy":"接面试线头"}\n（注：仅供参考 :)}'
        self.assertEqual(parse_profile_update(raw)["next_strategy"], "接面试线头")

    def test_first_of_multiple_objects(self):
        raw = '前言\n{"a":1}\n{"b":2}\n尾注'
        self.assertEqual(parse_profile_update(raw), {"a": 1})

    def test_skips_non_json_brace_before_real_object(self):
        # 第一个 { 不是合法 JSON（正文里的），应跳到下一个真正的对象。
        raw = '我觉得 {大概} 是这样：{"stage":"friend"}'
        self.assertEqual(parse_profile_update(raw)["stage"], "friend")


class TestMerge(unittest.TestCase):
    def test_merge_all_fields(self):
        p = UserProfile("u", "c")
        update = {
            "insights": [{"insight": "需要被听见", "confidence": 0.8, "evidence": "多次打断建议"}],
            "hypotheses": [{"guess": "和家人关系紧张", "confidence": 0.3, "next": "下次轻轻试探"}],
            "relationship": {"stage": "熟络", "last_topic": "面试", "open_threads": ["面试结果"],
                             "last_mood": "聊到面试焦虑，挂电话时还有点紧绷"},
            "next_strategy": "开场先接面试线头",
        }
        merge_profile(p, update)
        self.assertEqual(len(p.personality_model), 1)
        self.assertEqual(p.personality_model[0].insight, "需要被听见")
        self.assertEqual(p.personality_model[0].confidence, 0.8)
        self.assertEqual(len(p.open_hypotheses), 1)
        self.assertEqual(p.relationship.stage, "熟络")
        self.assertEqual(p.relationship.open_threads, ["面试结果"])
        self.assertEqual(p.relationship.last_mood, "聊到面试焦虑，挂电话时还有点紧绷")  # 情绪连续性
        self.assertEqual(p.next_strategy, "开场先接面试线头")

    def test_merge_dedups_and_caps_insights(self):
        p = UserProfile("u", "c")
        # 同一洞察反复出现 → 不重复堆叠，只更新置信度。
        for c in (0.5, 0.7, 0.9):
            merge_profile(p, {"insights": [{"insight": "需要被听见", "confidence": c}]})
        same = [i for i in p.personality_model if i.insight == "需要被听见"]
        self.assertEqual(len(same), 1)
        self.assertEqual(same[0].confidence, 0.9)
        # 不同洞察无限灌 → 截到上限，不会无限膨胀。
        for i in range(40):
            merge_profile(p, {"insights": [{"insight": f"洞察{i}"}]})
        self.assertLessEqual(len(p.personality_model), 20)

    def test_merge_prunes_lowest_confidence_not_oldest(self):
        # 超额按【置信度】淘汰：高置信的老判断不该被一堆低置信新猜测挤掉（旧法砍最旧会丢掉它）。
        p = UserProfile("u", "c")
        merge_profile(p, {"insights": [{"insight": "嘴硬心软", "confidence": 0.95}]})  # 老、高置信
        for i in range(25):  # 灌一堆低置信新猜测
            merge_profile(p, {"insights": [{"insight": f"猜测{i}", "confidence": 0.2}]})
        kept = [i.insight for i in p.personality_model]
        self.assertLessEqual(len(kept), 20)
        self.assertIn("嘴硬心软", kept)   # 高置信老判断留住（不被低置信新猜测顶掉）

    def test_merge_ignores_empty(self):
        p = UserProfile("u", "c")
        p.next_strategy = "原策略"
        merge_profile(p, {})
        self.assertEqual(p.next_strategy, "原策略")  # 空 update 不抹掉已有

    def test_merge_fact_profile_and_interaction_prefs(self):
        # 过去 prompt 读了没人写的两个死字段：现在增改落库、不删旧、防膨胀。
        p = UserProfile("u", "c")
        p.fact_profile = {"名字": "阿哲"}
        merge_profile(p, {"fact_profile": {"职业": "设计师"}, "interaction_prefs": {"沟通": "喜欢直接说重点"}})
        self.assertEqual(p.fact_profile["名字"], "阿哲")      # 旧的不删
        self.assertEqual(p.fact_profile["职业"], "设计师")    # 新的增上
        self.assertEqual(p.interaction_prefs["沟通"], "喜欢直接说重点")
        # 防膨胀：灌 40 条只留最近 30
        for i in range(40):
            merge_profile(p, {"fact_profile": {f"k{i}": f"v{i}"}})
        self.assertLessEqual(len(p.fact_profile), 30)

    def test_merge_curiosity_and_principles(self):
        # 前沿B 好奇缺口 + 前沿C 稳定原则：综合产出、限长限条、空不抹旧。
        p = UserProfile("u", "c")
        merge_profile(p, {"curiosity": "TA 到底为什么不肯休息",
                          "principles": ["嘴上逞强、其实怕给人添麻烦", "对在意的人格外较真"]})
        self.assertEqual(p.curiosity, "TA 到底为什么不肯休息")
        self.assertEqual(len(p.principles), 2)
        self.assertIn("怕给人添麻烦", p.principles[0])
        # 限 5 条
        merge_profile(p, {"principles": [f"原则{i}" for i in range(9)]})
        self.assertLessEqual(len(p.principles), 5)
        merge_profile(p, {})                       # 空不抹旧
        self.assertEqual(p.curiosity, "TA 到底为什么不肯休息")

    def test_merge_bond_character_side_evolves(self):
        # 角色侧关系内在状态（双向身份）：感情/被改变/角色议程/亲近度随每通演化、亲近度钳到 [0,1]。
        p = UserProfile("u", "c")
        merge_profile(p, {"bond": {"feeling": "越来越信任 TA", "changed_by": "以前嫌麻烦，现在会主动想起 TA 的事",
                                   "own_threads": ["想问问 TA 上次面试结果"], "closeness_delta": 0.15}})
        self.assertEqual(p.bond.feeling, "越来越信任 TA")
        self.assertIn("想起 TA", p.bond.changed_by)
        self.assertEqual(p.bond.own_threads, ["想问问 TA 上次面试结果"])
        self.assertAlmostEqual(p.bond.closeness, 0.15, places=3)
        # 单次涨幅封顶 0.3、总量钳到 1.0
        for _ in range(20):
            merge_profile(p, {"bond": {"closeness_delta": 0.9}})
        self.assertLessEqual(p.bond.closeness, 1.0)
        # 空 bond 不抹掉已有
        merge_profile(p, {"bond": {}})
        self.assertEqual(p.bond.feeling, "越来越信任 TA")

    def test_process_call_heuristic_backfills_fact_profile(self):
        # 慢脑没产出 fact_profile 时，启发式从用户原话兜底抽客观事实，跨通「记得你」不落空。
        import asyncio
        from micall.memory.repository import InMemoryRepository
        repo = InMemoryRepository()
        engine = UnderstandingEngine(StubLLM(["不是JSON"]), repo)  # 慢脑降级、无 fact_profile
        history = [{"role": "user", "content": "我叫阿哲，我在做设计"},
                   {"role": "assistant", "content": "辛苦"}]
        profile = asyncio.run(engine.process_call("u", "c", history))
        self.assertEqual(profile.fact_profile.get("名字"), "阿哲")
        self.assertEqual(profile.fact_profile.get("在做"), "做设计")


class TestFactImportance(unittest.TestCase):
    def test_normalize_string_and_dict(self):
        from micall.offline.understanding import _fact_text_importance
        self.assertEqual(_fact_text_importance("养了猫"), ("养了猫", 0.5))       # 字符串 → 默认重要性
        self.assertEqual(_fact_text_importance({"text": "下周手术", "importance": 0.9}),
                         ("下周手术", 0.9))
        self.assertEqual(_fact_text_importance({"text": "x", "importance": 5}), ("x", 1.0))   # 钳到 [0,1]
        self.assertEqual(_fact_text_importance({"text": "y", "importance": "bad"}), ("y", 0.5))  # 容错
        self.assertEqual(_fact_text_importance(123), ("", 0.5))                  # 非法 → 空

    def test_importance_flows_to_recall(self):
        # 慢脑给「要紧事」高 importance，召回时即便它更早，也排在更近的琐事前。
        repo = InMemoryRepository()
        update = {"new_facts": [{"text": "下周要去医院做手术", "importance": 0.95}]}
        engine = UnderstandingEngine(StubLLM([json.dumps(update, ensure_ascii=False)]), repo)
        history = [{"role": "user", "content": "随便聊聊，今天去医院旁边吃了面"},
                   {"role": "assistant", "content": "嗯"}]
        asyncio.run(engine.process_call("u", "c", history))
        hits = repo.recall("u", "c", "医院", top_k=2)
        self.assertEqual(hits[0], "下周要去医院做手术")   # 高重要性排前


class TestGroundingGate(unittest.TestCase):
    """信而核验（trust-but-verify）：慢脑凭空造的共同经历/事实，落不到对话里的就丢——治本，停掉打地鼠。"""

    def test_content_tokens_strips_framing(self):
        from micall.offline.understanding import _content_tokens
        toks = _content_tokens("那天一起聊到杨梅季")
        # 落款套话（那天/一起/聊到）不计，只留有辨识度的内容（杨梅 等）
        self.assertNotIn("那天", toks)
        self.assertNotIn("一起", toks)
        self.assertIn("杨梅", toks)

    def test_grounded_true_when_content_present(self):
        from micall.offline.understanding import _grounded_in_history
        h = [{"role": "user", "content": "最近杨梅上市了，酸得很"}, {"role": "assistant", "content": "是吗"}]
        self.assertTrue(_grounded_in_history("6月底一起聊到杨梅季", h))

    def test_ungrounded_when_fabricated_entity(self):
        from micall.offline.understanding import _grounded_in_history
        h = [{"role": "user", "content": "今天上班好累，开了一天会"}, {"role": "assistant", "content": "辛苦了"}]
        self.assertFalse(_grounded_in_history("你答应过老周一起去爬山", h))   # 老周/爬山对话里查无实据

    def test_no_content_token_kept_conservatively(self):
        from micall.offline.understanding import _grounded_in_history
        h = [{"role": "user", "content": "随便聊聊"}]
        # 抠不出任何可判定的内容词（纯落款套话）→ 保守判 True（不误删真记忆）
        self.assertTrue(_grounded_in_history("聊到", h))

    def test_merge_drops_ungrounded_shared_ref(self):
        # 慢脑硬塞一条对话里没发生的共同经历 → 核验后被丢；真聊到的那条保留。
        p = UserProfile("u", "c")
        history = [{"role": "user", "content": "今天去看了新出的科幻片，特效炸裂"},
                   {"role": "assistant", "content": "听着就过瘾"}]
        update = {"relationship": {"shared_refs": ["一起聊到那部科幻片的特效", "你答应过老周去钓鱼"]}}
        merge_profile(p, update, history)
        refs = p.relationship.shared_refs
        self.assertIn("一起聊到那部科幻片的特效", refs)      # 真聊到 → 留
        self.assertNotIn("你答应过老周去钓鱼", refs)         # 凭空造 → 丢

    def test_merge_without_history_keeps_all_refs(self):
        # 不传 history（如直接单元调用/旧路径）→ 不做核验，保持向后兼容、不误删。
        p = UserProfile("u", "c")
        merge_profile(p, {"relationship": {"shared_refs": ["你答应过老周去钓鱼"]}})
        self.assertIn("你答应过老周去钓鱼", p.relationship.shared_refs)

    def test_process_call_drops_ungrounded_slow_fact(self):
        # 慢脑新增事实落不到对话里 → 丢；但用户原话仍全量兜底入库（信息不丢）。
        repo = InMemoryRepository()
        update = {"new_facts": [{"text": "在上海开了家咖啡馆", "importance": 0.9}]}
        engine = UnderstandingEngine(StubLLM([json.dumps(update, ensure_ascii=False)]), repo)
        history = [{"role": "user", "content": "今天加班到很晚，累瘫了"},
                   {"role": "assistant", "content": "早点歇"}]
        asyncio.run(engine.process_call("u", "c", history))
        # 凭空的「咖啡馆」事实不该入库
        self.assertFalse(any("咖啡馆" in r for r in repo.recall("u", "c", "咖啡馆", top_k=5)))
        # 用户原话兜底仍在
        self.assertTrue(any("加班" in r for r in repo.recall("u", "c", "加班", top_k=5)))


class TestEngine(unittest.TestCase):
    def test_process_call_writes_both_layers(self):
        repo = InMemoryRepository()
        update = {
            "new_facts": ["喜欢猫，养了一只"],
            "insights": [{"insight": "焦虑时用自嘲掩饰", "confidence": 0.7}],
            "relationship": {"stage": "熟络", "last_topic": "面试"},
            "next_strategy": "开场接面试",
        }
        llm = StubLLM([json.dumps(update, ensure_ascii=False)])  # 注入返回 JSON 的慢脑
        engine = UnderstandingEngine(llm, repo)
        history = [
            {"role": "user", "content": "我在准备一场面试，有点紧张，家里还养了只猫"},
            {"role": "assistant", "content": "我陪着你。"},
        ]
        profile = asyncio.run(engine.process_call("u", "lin_wan", history))

        # 事实层：用户原话 + 模型抽取的 new_facts 都进了可检索的事实库。
        self.assertTrue(any("面试" in r for r in repo.recall("u", "lin_wan", "面试", top_k=5)))
        self.assertTrue(any("猫" in r for r in repo.recall("u", "lin_wan", "猫", top_k=5)))
        # 理解层：洞察 / 关系 / 下次策略都更新并持久化。
        self.assertEqual(profile.next_strategy, "开场接面试")
        self.assertEqual(profile.relationship.stage, "熟络")
        self.assertTrue(any(i.insight == "焦虑时用自嘲掩饰" for i in profile.personality_model))
        self.assertEqual(repo.get_profile("u", "lin_wan").next_strategy, "开场接面试")

    def test_process_call_degrades_on_non_json_llm(self):
        # stub 默认回复是对话文本（非 JSON）→ 画像不更新，但事实层仍写入，不报错。
        repo = InMemoryRepository()
        engine = UnderstandingEngine(StubLLM(), repo)
        history = [{"role": "user", "content": "今天好累"}]
        profile = asyncio.run(engine.process_call("u", "lin_wan", history))
        self.assertEqual(profile.next_strategy, "")
        self.assertTrue(any("累" in r for r in repo.recall("u", "lin_wan", "累", top_k=5)))


class TestRepetitionScore(unittest.TestCase):
    def test_repeat_scores_higher_than_varied(self):
        # 可观测：把「车轱辘话」量成一个数。反复说同一段 → 重复度明显高于句句新鲜。
        from micall.offline.understanding import repetition_score
        varied = ["今天天气真好啊", "你吃饭了吗", "我刚看了部电影挺有意思", "周末打算去爬山"]
        repeat = ["我刚在茶楼发呆茶都凉了", "我刚在茶楼坐了好久茶都凉透了", "我刚在茶楼发呆茶都凉了"]
        self.assertEqual(repetition_score([]), 0.0)
        self.assertEqual(repetition_score(["短"]), 0.0)          # 不足 n 字 → 0，不报噪
        self.assertGreater(repetition_score(repeat), repetition_score(varied))
        self.assertGreaterEqual(repetition_score(repeat), 0.2)   # 明显复读应被量到


if __name__ == "__main__":
    unittest.main()
