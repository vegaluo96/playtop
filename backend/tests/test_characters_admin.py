"""后台「角色管理」读写 —— 出厂 spec + overrides 合并、白名单字段、生效（docs/01 + 铁律7）。

不碰真实 overrides 文件：把 CHAR_OVERRIDES_PATH 指到临时文件。
"""
import tempfile
import unittest
from pathlib import Path

from micall.server import characters_admin as ca


def _a_factory_char():
    """取一个真实出厂角色 id 与其出厂 spec —— 避免测试硬编码具体角色（角色目录会换人）。"""
    specs = ca.factory_specs()
    cid = sorted(specs)[0]
    return cid, specs[cid]


class TestCharactersAdmin(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()) / "character_overrides.json"
        self._orig = ca.CHAR_OVERRIDES_PATH
        ca.CHAR_OVERRIDES_PATH = self.tmp

    def tearDown(self):
        ca.CHAR_OVERRIDES_PATH = self._orig
        if self.tmp.exists():
            self.tmp.unlink()

    def test_read_lists_factory_characters(self):
        cid, spec = _a_factory_char()
        rows = ca.read_characters_for_admin()
        ids = {r["id"] for r in rows}
        self.assertIn(cid, ids)
        row = next(r for r in rows if r["id"] == cid)
        self.assertEqual(row["name"], spec["identity"]["name"])
        self.assertIn(spec["persona"]["core_traits"][0], row["traits"])  # 列表字段 join 成可编辑串

    def test_write_then_effective_and_read_reflect(self):
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({
            "id": cid, "background_story": "改过的来历",
            "traits": "冷静、犀利", "voice_id": "male-qn-qingse",
            "speaking_style": "短句、克制",
        })
        eff = ca.effective_specs()[cid]
        self.assertEqual(eff["persona"]["background_story"], "改过的来历")
        self.assertEqual(eff["persona"]["core_traits"], ["冷静", "犀利"])  # 串拆回列表
        self.assertEqual(eff["persona"]["speaking_style"], "短句、克制")
        self.assertEqual(eff["voice"]["voice_id"], "male-qn-qingse")
        row = next(r for r in ca.read_characters_for_admin() if r["id"] == cid)
        self.assertEqual(row["voice_id"], "male-qn-qingse")
        self.assertEqual(row["background_story"], "改过的来历")

    def test_partial_edit_keeps_other_fields(self):
        cid, spec = _a_factory_char()
        orig_name = spec["identity"]["name"]
        ca.write_character_from_admin({"id": cid, "voice_id": "female-yujie"})
        eff = ca.effective_specs()[cid]
        self.assertEqual(eff["voice"]["voice_id"], "female-yujie")
        self.assertEqual(eff["identity"]["name"], orig_name)       # 没动的字段保留
        self.assertTrue(eff["persona"].get("core_traits"))         # 出厂人设还在

    def test_identity_fields_persist_and_reach_prompt(self):
        # 用户实测：后台改年龄等「基础资料」对不上通话——过去 write 根本不存身份字段。
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({
            "id": cid, "gender": "女", "age": "18",
            "nationality": "中国", "height": "156", "weight": "44", "birthday": "2006-01-01", "race": "东亚人",
        })
        eff = ca.effective_specs()[cid]
        self.assertEqual(eff["identity"]["age"], 18)              # 纯数字存成数字
        self.assertEqual(eff["identity"]["profile"]["height_cm"], 156)
        self.assertEqual(eff["identity"]["profile"]["birthday"], "2006-01-01")
        # 后台列表回显真值（而非写死 mock）
        row = next(r for r in ca.read_characters_for_admin() if r["id"] == cid)
        self.assertEqual(row["age"], 18)
        self.assertEqual(row["height"], 156)
        # 真正落进通话系统提示词
        from micall.context import CharacterRuntime, ContextAssembler
        char = CharacterRuntime.from_spec(eff)
        sysmsg = ContextAssembler(char).build(
            character_id=cid, scenario="", history=[{"role": "user", "content": "你多大"}])[0]["content"]
        self.assertIn("18岁", sysmsg)
        self.assertIn("身高156cm", sysmsg)

    def test_prompt_extra_persists_and_reaches_prompt(self):
        # 「本角色口吻提示」此前前端完全没接（admin/src 0 引用）；现已接通 state+表单+save。
        # 验证后端写入 → runtime_overrides.realtime_prompt_extra → 真正落进通话系统提示词。
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({"id": cid, "prompt_extra": "多用短句，偶尔毒舌"})
        eff = ca.effective_specs()[cid]
        self.assertEqual(eff["runtime_overrides"]["realtime_prompt_extra"], "多用短句，偶尔毒舌")
        row = next(r for r in ca.read_characters_for_admin() if r["id"] == cid)
        self.assertEqual(row["prompt_extra"], "多用短句，偶尔毒舌")   # 后台列表回显
        from micall.context import CharacterRuntime, ContextAssembler
        char = CharacterRuntime.from_spec(eff)
        sysmsg = ContextAssembler(char).build(
            character_id=cid, scenario="", history=[{"role": "user", "content": "在吗"}])[0]["content"]
        self.assertIn("多用短句，偶尔毒舌", sysmsg)

    def test_core_persists_reaches_prompt_and_survives_partial_edit(self):
        # 内核/spine：后台可编辑。验证写入 → persona.core → 落进系统提示词「你的内核」；
        # 且对其它字段的局部编辑不会冲掉出厂 core（深合并保底）。
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({"id": cid, "core": "你真正怕的是认真投入的东西其实没有生命力。"})
        eff = ca.effective_specs()[cid]
        self.assertEqual(eff["persona"]["core"], "你真正怕的是认真投入的东西其实没有生命力。")
        row = next(r for r in ca.read_characters_for_admin() if r["id"] == cid)
        self.assertEqual(row["core"], "你真正怕的是认真投入的东西其实没有生命力。")   # 后台回显
        from micall.context import CharacterRuntime, ContextAssembler
        char = CharacterRuntime.from_spec(eff)
        sysmsg = ContextAssembler(char).build(
            character_id=cid, scenario="", history=[{"role": "user", "content": "在吗"}])[0]["content"]
        self.assertIn("你的内核", sysmsg)
        self.assertIn("没有生命力", sysmsg)
        # 改个别字段（不带 core）不应抹掉 core
        ca.write_character_from_admin({"id": cid, "voice_id": "female-yujie"})
        self.assertEqual(ca.effective_specs()[cid]["persona"]["core"], "你真正怕的是认真投入的东西其实没有生命力。")

    def test_generate_core_uses_dimensions_and_parses_json(self):
        # 「AI 生成内核」：按现有维度提炼，解析 {"core":...}。用 StubLLM 注入回复。
        import asyncio

        from micall.providers import StubLLM
        llm = StubLLM(['{"core":"你最怕的是认真做的东西没人懂。"}'])
        core = asyncio.run(ca.generate_core(
            {"name": "测试", "summary": "嘴硬心软", "soft_spot": "被说不够好"}, llm))
        self.assertEqual(core, "你最怕的是认真做的东西没人懂。")

    def test_generate_core_falls_back_to_plain_text(self):
        # 模型没给合法 JSON 时退回纯文本（去围栏/引号）。
        import asyncio

        from micall.providers import StubLLM
        llm = StubLLM(["你真正在乎的是被记得。"])
        core = asyncio.run(ca.generate_core({"summary": "慢热"}, llm))
        self.assertEqual(core, "你真正在乎的是被记得。")

    def test_generate_core_rejects_empty_dimensions(self):
        import asyncio

        from micall.providers import StubLLM
        with self.assertRaises(ValueError):
            asyncio.run(ca.generate_core({}, StubLLM(['{"core":"x"}'])))

    def test_generate_character_includes_core_field(self):
        # AI 一键生成角色现在也产出 core。
        import asyncio

        from micall.providers import StubLLM
        reply = '{"name":"小柔","tagline":"t","gender":"女","age":22,"traits":"温柔","speaking_style":"轻","background_story":"b","likes":"l","dislikes":"d","values":"v","core":"你怕被遗忘。"}'
        fields = asyncio.run(ca.generate_character("温柔", StubLLM([reply])))
        self.assertEqual(fields["core"], "你怕被遗忘。")
        self.assertEqual(fields["name"], "小柔")

    def test_per_character_knobs_roundtrip_and_clear(self):
        # 角色级旋钮（话长/记忆深度）后台可编辑：写入 runtime_overrides、回显、空字符串清空回退全局。
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({"id": cid, "reply_max_tokens": "800", "memory_depth": "12"})
        eff = ca.effective_specs()[cid]["runtime_overrides"]
        self.assertEqual(eff["reply_max_tokens"], 800)
        self.assertEqual(eff["memory_depth"], 12)
        row = next(r for r in ca.read_characters_for_admin() if r["id"] == cid)
        self.assertEqual(row["reply_max_tokens"], 800)
        # 上限钳制
        ca.write_character_from_admin({"id": cid, "reply_max_tokens": "99999"})
        self.assertEqual(ca.effective_specs()[cid]["runtime_overrides"]["reply_max_tokens"], 4096)
        # 空字符串=清空覆盖、回退全局（出厂 spec 该键常为 null，清后 effective 为 falsy → 编排层走全局默认）
        ca.write_character_from_admin({"id": cid, "reply_max_tokens": ""})
        self.assertFalse(ca.effective_specs()[cid]["runtime_overrides"].get("reply_max_tokens"))
        self.assertEqual(next(r for r in ca.read_characters_for_admin() if r["id"] == cid)["reply_max_tokens"], "")

    def test_nonnumeric_age_is_rejected_not_stored(self):
        # num() 此前对 "abc" 原样返回 → 会把非数字落进 identity（提示词出现「年龄abc」）。现应跳过、保留出厂值。
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({"id": cid, "age": "abc", "height": "拾陆"})
        eff = ca.effective_specs()[cid]
        self.assertNotEqual(eff["identity"].get("age"), "abc")
        self.assertNotEqual((eff["identity"].get("profile") or {}).get("height_cm"), "拾陆")

    def test_long_text_fields_are_capped(self):
        # 文本字段无上限会撑爆系统提示词；现按字段封顶（background_story 4000）。
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({"id": cid, "background_story": "床" * 5000})
        eff = ca.effective_specs()[cid]
        self.assertEqual(len(eff["persona"]["background_story"]), 4000)

    def test_write_rejects_unknown_id(self):
        with self.assertRaises(ValueError):
            ca.write_character_from_admin({"id": "nope", "name": "x"})

    def test_factory_spec_on_disk_unchanged(self):
        cid, spec = _a_factory_char()
        orig_name = spec["identity"]["name"]
        ca.write_character_from_admin({"id": cid, "name": "改名"})
        self.assertEqual(ca.factory_specs()[cid]["identity"]["name"], orig_name)  # 出厂文件不动

    def test_public_characters_surface_vs_backstage(self):
        """第一性原理分界：富化展示维度对外吐；导演提示(说话风格)+秘密深度(软肋/内里/价值观)绝不上卡片。"""
        cid, spec = _a_factory_char()
        card = next(c for c in ca.public_characters() if c["id"] == cid)
        for k in ("occupation", "residence", "mbti", "summary", "hobbies", "catchphrases", "quirks"):
            self.assertIn(k, card)
        self.assertEqual(card["occupation"], spec["identity"]["occupation"])
        self.assertTrue(card["catchphrases"] and card["hobbies"])
        for k in ("soft_spot", "speaking_style", "hidden_layer", "values_and_boundaries"):
            self.assertNotIn(k, card)


class TestRuntimePicksUpOverride(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()) / "character_overrides.json"
        self._orig = ca.CHAR_OVERRIDES_PATH
        ca.CHAR_OVERRIDES_PATH = self.tmp

    def tearDown(self):
        ca.CHAR_OVERRIDES_PATH = self._orig
        if self.tmp.exists():
            self.tmp.unlink()

    def test_load_characters_reflects_override(self):
        from micall.server.wsserver import _load_characters
        cid, _ = _a_factory_char()
        ca.write_character_from_admin({"id": cid, "voice_id": "audiobook_male_2"})
        chars = _load_characters()
        self.assertEqual(chars[cid].voice_id, "audiobook_male_2")  # 通话端拿到改后的音色


class TestAutonomousSeed(unittest.TestCase):
    """初始近况预置：DB 无状态时回退 spec 的 autonomous_seed；DB 一旦有真实状态就以 DB 为准。"""

    def setUp(self):
        self._orig = ca.effective_specs
        ca.effective_specs = lambda: {"c1": {"autonomous_seed": {
            "mood": "挺好，刚忙完一阵", "recent_experience": "在排练一首新曲子",
            "energy": "精神不错", "anticipating": "周末的小型演出"}}}

    def tearDown(self):
        ca.effective_specs = self._orig

    def test_seed_fallback_then_db_wins(self):
        from micall.context.models import AutonomousState
        from micall.memory import InMemoryRepository
        repo = InMemoryRepository()
        st = ca.effective_autonomous(repo, "c1")           # DB 空 → 回退出厂种子
        self.assertEqual(st.mood, "挺好，刚忙完一阵")
        self.assertEqual(st.anticipating, "周末的小型演出")
        self.assertEqual(ca.effective_autonomous(repo, "x"), AutonomousState())  # 无种子 → 空
        repo.save_autonomous("c1", AutonomousState(mood="今天有点闷"))            # DB 有真实状态
        self.assertEqual(ca.effective_autonomous(repo, "c1").mood, "今天有点闷")  # → 以 DB 为准


class TestCallSessionBuildWiring(unittest.TestCase):
    """回归：通话「建会话」路径必须能跑通——effective_autonomous 曾在 wsserver 漏导入，
    建会话即 NameError → 用户端一直接通失败，而既有测试都没走真正的 _make_session。"""

    def test_make_session_builds_with_effective_autonomous(self):
        from micall.config import load_config
        from micall.memory import InMemoryRepository
        from micall.server.wsserver import SignalingServer
        srv = SignalingServer(load_config(), InMemoryRepository())
        cid = sorted(srv.characters)[0]

        async def emit(_ev):
            pass

        sess = srv._make_session(emit=emit, character_id=cid, scenario="")  # 不得抛 NameError
        self.assertIsNotNone(sess)
        self.assertEqual(sess.character_id, cid)


if __name__ == "__main__":
    unittest.main()
