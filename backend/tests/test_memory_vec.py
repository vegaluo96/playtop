"""记忆检索向量化（Embedding 节点）与长记忆脑接线 —— docs/02 §3.1/§3.3。

不依赖网络：用假 embedder 注入向量，验证余弦召回、关键词兜底、事实向量化与工厂回退。
"""
import asyncio
import json
import unittest

from micall.config import load_config
from micall.context import CharacterRuntime, ContextAssembler, UserProfile
from micall.memory import InMemoryRepository
from micall.offline import UnderstandingEngine
from micall.providers import StubLLM, make_embedding, make_llm


class _FakeEmbedder:
    """把文本映射成确定向量：按关键词点亮固定维度，便于断言余弦排序。"""
    DIMS = ["猫", "面试", "雨", "咖啡"]

    async def embed(self, texts):
        return [self._vec(t) for t in texts]

    async def embed_one(self, text):
        return self._vec(text)

    def _vec(self, text):
        return [1.0 if d in text else 0.0 for d in self.DIMS]


class TestRecallVec(unittest.TestCase):
    def test_cosine_ranks_semantically(self):
        r = InMemoryRepository()
        emb = _FakeEmbedder()
        r.add_fact("u", "c", "养了一只猫叫团子", vector=asyncio.run(emb.embed_one("养了一只猫叫团子")))
        r.add_fact("u", "c", "最近在准备面试", vector=asyncio.run(emb.embed_one("最近在准备面试")))
        qv = asyncio.run(emb.embed_one("猫怎么样了"))
        hits = r.recall_vec("u", "c", qv, query="猫怎么样了", top_k=1)
        self.assertEqual(hits, ["养了一只猫叫团子"])  # 余弦命中「猫」那条

    def test_falls_back_to_keyword_without_vectors(self):
        r = InMemoryRepository()
        r.add_fact("u", "c", "养了一只猫")  # 没存向量
        # 传了 query_vector 但库里无向量 → 退关键词召回，仍能命中。
        hits = r.recall_vec("u", "c", [1.0, 0, 0, 0], query="猫", top_k=3)
        self.assertTrue(any("猫" in h for h in hits))

    def test_empty_query_vector_falls_back_to_keyword(self):
        # 空向量 []（embedding 失败/未配）应明确判空 → 退关键词召回，不报错也不漏召回。
        r = InMemoryRepository()
        emb = _FakeEmbedder()
        r.add_fact("u", "c", "养了一只猫", vector=asyncio.run(emb.embed_one("猫")))
        hits = r.recall_vec("u", "c", [], query="猫", top_k=3)
        self.assertTrue(any("猫" in h for h in hits))


class TestAssemblerVec(unittest.TestCase):
    def test_build_uses_vector_recall_when_query_vector_given(self):
        r = InMemoryRepository()
        emb = _FakeEmbedder()
        r.add_fact("u", "lin_wan", "养了一只猫叫团子", vector=asyncio.run(emb.embed_one("猫")))
        r.add_fact("u", "lin_wan", "在准备面试", vector=asyncio.run(emb.embed_one("面试")))
        a = ContextAssembler(CharacterRuntime("lin_wan", "林晚", {}),
                             profile=UserProfile("u", "lin_wan"), memory=r)
        qv = asyncio.run(emb.embed_one("我家猫"))
        msgs = a.build(character_id="lin_wan", scenario="",
                       history=[{"role": "user", "content": "我家猫"}], query_vector=qv)
        # 余弦召回的「团子」折进末轮 user（前缀缓存友好），且不是面试那条。
        self.assertIn("团子", msgs[-1]["content"])
        self.assertNotIn("面试", msgs[-1]["content"])


class TestFactoryAndEngine(unittest.TestCase):
    def test_make_embedding_none_when_unconfigured(self):
        # default.json 的 embedding 有 endpoint 但无 key → 未配置 → None（退关键词召回）。
        self.assertIsNone(make_embedding(load_config().node("embedding")))

    def test_slow_llm_routes_to_real_provider_when_configured(self):
        # apiyi_qwen_long 之前漏在 make_llm 路由外 → 长记忆脑静默退化 stub；现应路由到真实 provider。
        from micall.config import NodeConfig
        node = NodeConfig(name="llm_slow", provider="apiyi_qwen_long",
                          endpoint="https://api.apiyi.com/v1/chat/completions",
                          api_key="sk-test", params={"model": "Qwen-Long"})
        # 测试环境可能没装 httpx：ApiyiLLM 构造会抛 httpx 缺失——但这本身就证明路由到了
        # ApiyiLLM 而非 StubLLM（StubLLM 永不抛）。装了 httpx 则直接断言类型。
        try:
            self.assertEqual(type(make_llm(node)).__name__, "ApiyiLLM")
        except RuntimeError as e:
            self.assertIn("httpx", str(e))

    def test_understanding_vectorizes_facts_when_embedder_present(self):
        repo = InMemoryRepository()
        update = {"new_facts": ["养了一只猫"], "next_strategy": "接面试"}
        engine = UnderstandingEngine(
            StubLLM([json.dumps(update, ensure_ascii=False)]), repo, embedder=_FakeEmbedder()
        )
        history = [{"role": "user", "content": "最近在准备面试"}]
        asyncio.run(engine.process_call("u", "lin_wan", history))
        # 事实带上了向量 → recall_vec 走余弦，能按语义命中。
        qv = asyncio.run(_FakeEmbedder().embed_one("猫"))
        hits = repo.recall_vec("u", "lin_wan", qv, query="猫", top_k=1)
        self.assertEqual(hits, ["养了一只猫"])


if __name__ == "__main__":
    unittest.main()
