"""后台「角色管理」读写 —— 出厂 spec + overrides 合并、白名单字段、生效（docs/01 + 铁律7）。

不碰真实 overrides 文件：把 CHAR_OVERRIDES_PATH 指到临时文件。
"""
import tempfile
import unittest
from pathlib import Path

from micall.server import characters_admin as ca


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
        rows = ca.read_characters_for_admin()
        ids = {r["id"] for r in rows}
        self.assertIn("lin_wan", ids)
        lw = next(r for r in rows if r["id"] == "lin_wan")
        self.assertEqual(lw["name"], "林晚")
        self.assertIn("温柔", lw["traits"])        # 列表字段 join 成可编辑串

    def test_write_then_effective_and_read_reflect(self):
        ca.write_character_from_admin({
            "id": "lin_wan", "background_story": "改过的来历",
            "traits": "冷静、犀利", "voice_id": "male-qn-qingse",
            "speaking_style": "短句、克制",
        })
        eff = ca.effective_specs()["lin_wan"]
        self.assertEqual(eff["persona"]["background_story"], "改过的来历")
        self.assertEqual(eff["persona"]["core_traits"], ["冷静", "犀利"])  # 串拆回列表
        self.assertEqual(eff["persona"]["speaking_style"], "短句、克制")
        self.assertEqual(eff["voice"]["voice_id"], "male-qn-qingse")
        lw = next(r for r in ca.read_characters_for_admin() if r["id"] == "lin_wan")
        self.assertEqual(lw["voice_id"], "male-qn-qingse")
        self.assertEqual(lw["background_story"], "改过的来历")

    def test_partial_edit_keeps_other_fields(self):
        ca.write_character_from_admin({"id": "lin_wan", "voice_id": "female-yujie"})
        eff = ca.effective_specs()["lin_wan"]
        self.assertEqual(eff["voice"]["voice_id"], "female-yujie")
        self.assertEqual(eff["identity"]["name"], "林晚")          # 没动的字段保留
        self.assertTrue(eff["persona"].get("core_traits"))         # 出厂人设还在

    def test_write_rejects_unknown_id(self):
        with self.assertRaises(ValueError):
            ca.write_character_from_admin({"id": "nope", "name": "x"})

    def test_factory_spec_on_disk_unchanged(self):
        ca.write_character_from_admin({"id": "lin_wan", "name": "改名"})
        self.assertEqual(ca.factory_specs()["lin_wan"]["identity"]["name"], "林晚")  # 出厂文件不动


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
        ca.write_character_from_admin({"id": "lin_wan", "voice_id": "audiobook_male_2"})
        chars = _load_characters()
        self.assertEqual(chars["lin_wan"].voice_id, "audiobook_male_2")  # 通话端拿到改后的音色


if __name__ == "__main__":
    unittest.main()
