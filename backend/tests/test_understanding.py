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


class TestParse(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(parse_profile_update('{"next_strategy":"轻轻问"}')["next_strategy"], "轻轻问")

    def test_wrapped_json(self):
        raw = "好的，分析如下：\n{\"next_strategy\":\"接面试线头\"}\n以上。"
        self.assertEqual(parse_profile_update(raw)["next_strategy"], "接面试线头")

    def test_garbage_returns_empty(self):
        self.assertEqual(parse_profile_update("这里没有 JSON"), {})
        self.assertEqual(parse_profile_update("{坏的"), {})


class TestMerge(unittest.TestCase):
    def test_merge_all_fields(self):
        p = UserProfile("u", "c")
        update = {
            "insights": [{"insight": "需要被听见", "confidence": 0.8, "evidence": "多次打断建议"}],
            "hypotheses": [{"guess": "和家人关系紧张", "confidence": 0.3, "next": "下次轻轻试探"}],
            "relationship": {"stage": "熟络", "last_topic": "面试", "open_threads": ["面试结果"]},
            "next_strategy": "开场先接面试线头",
        }
        merge_profile(p, update)
        self.assertEqual(len(p.personality_model), 1)
        self.assertEqual(p.personality_model[0].insight, "需要被听见")
        self.assertEqual(p.personality_model[0].confidence, 0.8)
        self.assertEqual(len(p.open_hypotheses), 1)
        self.assertEqual(p.relationship.stage, "熟络")
        self.assertEqual(p.relationship.open_threads, ["面试结果"])
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

    def test_merge_ignores_empty(self):
        p = UserProfile("u", "c")
        p.next_strategy = "原策略"
        merge_profile(p, {})
        self.assertEqual(p.next_strategy, "原策略")  # 空 update 不抹掉已有


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
            {"role": "user", "content": "我在准备一场面试，有点紧张"},
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


if __name__ == "__main__":
    unittest.main()
