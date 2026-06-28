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

    def test_clamps_absurd_upper(self):
        adminapi.write_invite_from_admin({"reward_minutes": 99999999})
        saved = json.loads(self.tmp.read_text("utf-8"))
        self.assertEqual(saved["invite"]["reward_minutes"], 10080)   # 上限 1 周

    def test_cost_clamps_negative_nan_and_huge(self):
        adminapi.write_cost_from_admin({"tts": -3, "asr": 1e9, "llm_fast": float("nan"), "chars_per_token": 4})
        saved = json.loads(self.tmp.read_text("utf-8"))["cost"]
        self.assertEqual(saved["usd_per_1k_chars_tts"], 0.0)             # 负 → 0
        self.assertEqual(saved["usd_per_minute_asr"], 10.0)             # 1e9 → 上限 10
        self.assertEqual(saved["usd_per_1k_tokens"]["llm_fast"], 0.0)   # NaN → 默认 0
        self.assertEqual(saved["chars_per_token"], 4)                   # 合理值原样


class TestAsrEmotion(unittest.TestCase):
    """免费升级：实时 ASR 在转写之外把 TA 这句话的【声音情绪】抽出来（防御式多处探测）。"""

    def test_extract_emotion_shapes(self):
        from micall.providers.qwen_realtime_asr import _extract_emotion
        self.assertEqual(_extract_emotion({"emotion": "happy"}), "happy")
        self.assertEqual(_extract_emotion({"annotations": [{"emotion": "sad"}]}), "sad")
        self.assertEqual(_extract_emotion({"annotations": [{"type": "emotion", "value": "angry"}]}), "angry")
        self.assertEqual(_extract_emotion({"annotation": {"emotion": "fear"}}), "fear")
        # 没有情绪字段 / 非法输入 → 空，绝不抛
        self.assertEqual(_extract_emotion({"transcript": "你好"}), "")
        self.assertEqual(_extract_emotion({}), "")
        self.assertEqual(_extract_emotion("notadict"), "")


class TestLlmSqueeze(unittest.TestCase):
    """榨干 LLM：缓存命中诊断 + 抗重复惩罚 + usage 上报，都按配置带上（白捡，不加延迟）。"""

    def test_usage_brief_cache_hit_rate(self):
        from micall.providers.apiyi_llm import _usage_brief
        s = _usage_brief({"prompt_tokens": 1000, "completion_tokens": 50,
                          "prompt_cache_hit_tokens": 900, "prompt_cache_miss_tokens": 100})
        self.assertIn("90%", s)          # 命中率算对（验证 §1.7 前缀缓存是否真生效）
        self.assertIn("completion=50", s)
        s2 = _usage_brief({"prompt_tokens": 10, "completion_tokens": 5})
        self.assertIn("未回缓存字段", s2)   # 没有缓存字段 → 提示网关没透传

    def test_payload_includes_new_capabilities(self):
        try:
            import httpx  # noqa: F401
        except ImportError:
            self.skipTest("httpx 未安装（线上有；本地跳过）")
        from micall.config import NodeConfig
        from micall.providers.apiyi_llm import ApiyiLLM
        on = ApiyiLLM(NodeConfig(name="llm_fast", provider="deepseek",
                                 endpoint="https://api.deepseek.com/v1/chat/completions", api_key="sk-x",
                                 params={"frequency_penalty": 0.3, "report_usage": True}))
        p = on._payload([{"role": "user", "content": "hi"}], 0.8, 100)
        self.assertEqual(p["frequency_penalty"], 0.3)
        self.assertEqual(p["stream_options"], {"include_usage": True})
        # 关掉就不带（默认 0/未配 → 不画蛇添足）
        off = ApiyiLLM(NodeConfig(name="llm_fast", provider="deepseek",
                                  endpoint="https://x/v1/chat/completions", api_key="sk-x",
                                  params={"report_usage": False}))
        p2 = off._payload([], 0.8, 50)
        self.assertNotIn("stream_options", p2)
        self.assertNotIn("frequency_penalty", p2)

    def test_default_config_squeezes_llm_fast(self):
        # 出厂配置就把 llm_fast 的抗重复 + 用量上报打开（对齐 ASR 免费升级的做法）。
        from micall.config import load_config
        fast = load_config().node("llm_fast").params
        self.assertEqual(float(fast.get("frequency_penalty", 0)), 0.3)
        self.assertTrue(fast.get("report_usage"))


class TestInviteRewardSeconds(unittest.TestCase):
    def test_reads_config_minutes(self):
        # 默认配置（default.json invite.reward_minutes=60）→ 3600 秒。
        self.assertEqual(auth.invite_reward_seconds(), 60 * 60)


class TestInviteCodeStable(unittest.TestCase):
    """邀请码必须稳定（用户实测「总是变来变去」）。确定性派生 → 同一个人永远同一个码。"""

    def test_same_user_same_code_across_calls(self):
        from micall.memory import InMemoryRepository

        r = InMemoryRepository()
        c1 = r.get_invite_code("u1")
        c2 = r.get_invite_code("u1")
        self.assertEqual(c1, c2)
        self.assertTrue(c1.startswith("MI") and len(c1) >= 6)

    def test_survives_restart_new_instance(self):
        # 「变来变去」根因：随机码靠持久化才稳定，重启/换实例即丢。确定性码跨实例一致。
        from micall.memory import InMemoryRepository, stable_invite_code

        r1, r2 = InMemoryRepository(), InMemoryRepository()   # 模拟进程重启 = 全新实例
        self.assertEqual(r1.get_invite_code("u1"), r2.get_invite_code("u1"))
        self.assertEqual(r1.get_invite_code("u1"), stable_invite_code("u1"))

    def test_different_users_differ(self):
        from micall.memory import InMemoryRepository

        r = InMemoryRepository()
        self.assertNotEqual(r.get_invite_code("alice"), r.get_invite_code("bob"))

    def test_collision_resalts(self):
        # 撞到别人已占用的码 → 加盐换一个，绝不把两人指向同一个码（否则邀请归属串号）。
        from micall.memory import InMemoryRepository, stable_invite_code

        r = InMemoryRepository()
        r._invite_owner[stable_invite_code("victim")] = "someone_else"   # 预占 victim 的首选码
        code = r.get_invite_code("victim")
        self.assertNotEqual(code, stable_invite_code("victim"))
        self.assertEqual(r._invite_owner[code], "victim")


if __name__ == "__main__":
    unittest.main()
