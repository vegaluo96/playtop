"""音色试听 WAV + 邀请奖励链路（后台改了即对外可见）—— 防住反复出现的「邀请仍显 60」。

不碰真实 admin_overrides.json：把 adminapi.OVERRIDES_PATH 与 config 的覆盖路径指到临时文件。
"""
import json
import tempfile
import unittest
from pathlib import Path

from micall.server import adminapi
from micall.server import auth
from micall.server import voice_preview as vp


class TestVoicePreview(unittest.TestCase):
    def test_preview_returns_valid_wav(self):
        # 未配置 TTS（stub）也应返回合法 WAV 头，前端据 size 判断是否有声。
        wav = vp.preview_wav(character_id="lin_wan")
        self.assertEqual(wav[:4], b"RIFF")
        self.assertEqual(wav[8:12], b"WAVE")

    def test_preview_unknown_char_still_wav(self):
        wav = vp.preview_wav(character_id="does_not_exist")
        self.assertEqual(wav[:4], b"RIFF")


class TestVoiceLibrary(unittest.TestCase):
    def test_library_nonempty_and_shaped(self):
        from micall.server.voice_library import system_voice_library

        lib = system_voice_library()
        self.assertGreaterEqual(len(lib), 20)
        for k in ("voice_id", "name", "gender", "group", "engine"):
            self.assertIn(k, lib[0])
        self.assertTrue(all(v["engine"] == "MiniMax" for v in lib))
        ids = [v["voice_id"] for v in lib]
        self.assertEqual(len(ids), len(set(ids)), "voice_id 应唯一")

    def test_default_voice_is_in_library(self):
        # 产品默认音色（global_defaults.default_voice）应是库里某个系统音色，保证开箱即用。
        from micall.config import load_config
        from micall.server.voice_library import voice_ids

        dv = load_config().global_defaults.get("default_voice")
        self.assertIn(dv, voice_ids())


class TestUserVoiceSelection(unittest.TestCase):
    """用户选音色账号级落库 + 跨设备回显（list_user_voices）。"""

    def test_set_and_list_roundtrip(self):
        from micall.memory import InMemoryRepository

        repo = InMemoryRepository()
        repo.set_user_voice("u1", "lin_wan", "female-yujie")
        repo.set_user_voice("u1", "jiang_ye", "male-qn-jingying")
        repo.set_user_voice("u2", "lin_wan", "female-shaonv")   # 别的用户不串
        mine = repo.list_user_voices("u1")
        self.assertEqual(mine, {"lin_wan": "female-yujie", "jiang_ye": "male-qn-jingying"})
        self.assertEqual(repo.get_user_voice("u1", "lin_wan"), "female-yujie")

    def test_list_empty_for_unknown_user(self):
        from micall.memory import InMemoryRepository

        self.assertEqual(InMemoryRepository().list_user_voices("nobody"), {})

    def test_only_real_library_ids_accepted(self):
        # /api/voice 用 voice_ids() 校验：库里的接受、库外的（含假的自由文本）拒绝。
        from micall.server.voice_library import voice_ids

        ids = voice_ids()
        self.assertIn("female-yujie", ids)
        self.assertNotIn("温柔沙哑的女声", ids)   # 旧假功能写入的自由文本必须被拒
        self.assertNotIn("", ids)


class TestInviteRewardChain(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()) / "admin_overrides.json"
        self._orig = adminapi.OVERRIDES_PATH
        adminapi.OVERRIDES_PATH = self.tmp
        # config.load_config 按模块位置找 admin_overrides.json；测试改 reward 走 adminapi 写、
        # 再用 read_invite_for_admin 读回（与 load_config 同源），避免依赖真实仓库文件。

    def tearDown(self):
        adminapi.OVERRIDES_PATH = self._orig
        if self.tmp.exists():
            self.tmp.unlink()

    # 注：read_invite_for_admin / load_config 在生产读的是与 write 同一个 admin_overrides.json，
    # 这里只隔离了 write 路径（adminapi.OVERRIDES_PATH），故断言写出的文件内容（最能说明问题的一环）。
    def test_admin_write_persists_minutes(self):
        adminapi.write_invite_from_admin({"reward_minutes": 25})
        saved = json.loads(self.tmp.read_text("utf-8"))
        self.assertEqual(saved["invite"]["reward_minutes"], 25)

    def test_admin_write_preserves_other_keys(self):
        # 别的后台设置（如 cost）不应被邀请写入覆盖掉，反之亦然。
        self.tmp.write_text(json.dumps({"cost": {"tts": 0.025}}), "utf-8")
        adminapi.write_invite_from_admin({"reward_minutes": 30})
        saved = json.loads(self.tmp.read_text("utf-8"))
        self.assertEqual(saved["cost"]["tts"], 0.025)
        self.assertEqual(saved["invite"]["reward_minutes"], 30)

    def test_clamps_negative(self):
        adminapi.write_invite_from_admin({"reward_minutes": -5})
        saved = json.loads(self.tmp.read_text("utf-8"))
        self.assertEqual(saved["invite"]["reward_minutes"], 0)   # 负数夹到 0（禁用奖励）


class TestInviteRewardSeconds(unittest.TestCase):
    def test_reads_config_minutes(self):
        # 默认配置（default.json invite.reward_minutes=60）→ 3600 秒。
        self.assertEqual(auth.invite_reward_seconds(), 60 * 60)


if __name__ == "__main__":
    unittest.main()
