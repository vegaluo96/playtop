"""世界库即记忆·四层：天气连续性(A) + 自主自传连续(B) + 世界进 shared_refs(C) + 显著性衰减(D)。"""
import asyncio
import datetime
import json
import pathlib
import tempfile
import unittest

import micall.offline.world_context as wc
from micall.context.assembler import _world_topics_line
from micall.context.models import AutonomousState, CharacterRuntime, UserProfile
from micall.memory import InMemoryRepository
from micall.offline import AutonomyEngine, build_autonomy_prompt, merge_profile
from micall.offline.understanding import build_understanding_prompt
from micall.offline.world_context import fetch_topics
from micall.providers import StubLLM

TZ = datetime.timezone(datetime.timedelta(hours=8))


# ───────────────────── Layer A：天气连续性（变化感 > 绝对值）+ 持久化 ─────────────────────
class TestTrendPhrase(unittest.TestCase):
    def test_rain_to_clear(self):
        self.assertIn("放晴", wc._trend_phrase(15, 61, 24, 0))   # 雨→晴

    def test_clear_to_rain(self):
        self.assertIn("下", wc._trend_phrase(24, 0, 18, 63))     # 晴→雨

    def test_sustained_rain(self):
        self.assertIn("好几天", wc._trend_phrase(18, 61, 17, 63))

    def test_warmer_colder(self):
        self.assertIn("暖和", wc._trend_phrase(10, 0, 18, 0))
        self.assertIn("凉", wc._trend_phrase(22, 0, 14, 0))

    def test_no_notable_change(self):
        self.assertEqual(wc._trend_phrase(20, 0, 21, 1), "")     # 小变化、都不下雨 → 无趋势词


class TestWorldStore(unittest.TestCase):
    def setUp(self):
        self._snap = json.dumps(wc._WORLD, ensure_ascii=False)
        self._path = wc._STORE_PATH

    def tearDown(self):
        d = json.loads(self._snap)
        wc._WORLD["date"], wc._WORLD["weather"] = d["date"], d["weather"]
        wc._WORLD["weather_hist"], wc._WORLD["topics"] = d["weather_hist"], d["topics"]
        wc._STORE_PATH = self._path

    def test_weather_trend_reads_history(self):
        now = datetime.datetime(2026, 6, 28, 12, tzinfo=TZ)
        wc._WORLD["date"] = wc._date(now)
        wc._WORLD["weather_hist"] = {"上海": [
            {"date": "2026-06-27", "temp": 14, "code": 61},   # 昨天：小雨
            {"date": "2026-06-28", "temp": 24, "code": 0},    # 今天：晴
        ]}
        self.assertIn("放晴", wc.weather_trend("上海", now))
        self.assertEqual(wc.weather_trend("没历史的城", now), "")

    def test_persistence_roundtrip(self):
        tmp = pathlib.Path(tempfile.mkdtemp()) / "w.json"
        wc.configure_store(str(tmp))            # 启用 + 载入（文件不存在=noop）
        wc._WORLD["date"] = "2026-06-28"
        wc._WORLD["topics"] = ["杨梅季", "新番"]
        wc._WORLD["weather_hist"] = {"上海": [{"date": "2026-06-28", "temp": 24, "code": 0}]}
        wc._save_store()
        wc._WORLD["date"], wc._WORLD["topics"], wc._WORLD["weather_hist"] = "", [], {}
        wc._load_store()                        # 从盘恢复 → 跨重启连续性成立
        self.assertEqual(wc._WORLD["date"], "2026-06-28")
        self.assertEqual(wc._WORLD["topics"], ["杨梅季", "新番"])
        self.assertIn("上海", wc._WORLD["weather_hist"])
        wc.configure_store("")                  # 关持久化，免污染别的测试

    def test_world_snapshot_shape(self):
        now = datetime.datetime(2026, 6, 28, 12, tzinfo=TZ)
        wc._WORLD["date"] = wc._date(now)
        wc._WORLD["weather"] = {"上海": "今天上海晴，24°C"}
        wc._WORLD["topics"] = ["杨梅季"]
        snap = wc.world_snapshot(now)
        self.assertTrue(snap["fresh"])
        self.assertEqual(snap["topics"], ["杨梅季"])
        self.assertEqual(snap["weather"], [{"city": "上海", "line": "今天上海晴，24°C"}])


# ───────────────────── Layer B：自主状态自传式连续 + 天气接地 ─────────────────────
class TestAutobiographicalContinuity(unittest.TestCase):
    def test_prompt_continues_from_prev(self):
        prev = AutonomousState(mood="有点累", recent_experience="赶稿子", energy="乏", anticipating="周末看展")
        sys = build_autonomy_prompt(CharacterRuntime("c", "林晚", {"core_traits": ["温柔"]}), 24, prev=prev)[0]["content"]
        self.assertIn("上一次", sys)
        self.assertIn("接着往下过", sys)
        self.assertIn("赶稿子", sys)

    def test_prompt_no_continuity_without_prev(self):
        sys = build_autonomy_prompt(CharacterRuntime("c", "林晚", {}), 24, prev=AutonomousState())[0]["content"]
        self.assertNotIn("上一次", sys)

    def test_advance_folds_weather_and_trend_into_local_context(self):
        snap = json.dumps(wc._WORLD, ensure_ascii=False)
        try:
            now = datetime.datetime.now(TZ)
            today, yest = wc._date(now), wc._date(now - datetime.timedelta(days=1))
            wc._WORLD["date"] = today
            wc._WORLD["weather"] = {"上海": "今天上海晴，24°C"}
            wc._WORLD["weather_hist"] = {"上海": [
                {"date": yest, "temp": 14, "code": 61}, {"date": today, "temp": 24, "code": 0}]}
            repo = InMemoryRepository()
            eng = AutonomyEngine(StubLLM([json.dumps({"mood": "还行"}, ensure_ascii=False)]), repo)
            char = CharacterRuntime("c", "维佳", {"core_traits": ["飒"]}, {"residence": "上海"})
            out = asyncio.run(eng.advance(char, hours_since_last_call=24))
            self.assertIn("今天上海晴", out.local_context)   # 真实天气
            self.assertIn("放晴", out.local_context)         # 连续性：前两天阴雨→今天放晴
        finally:
            d = json.loads(snap)
            for k in ("date", "weather", "weather_hist", "topics"):
                wc._WORLD[k] = d[k]


# ───────────────────── Layer C：世界进 shared_refs（共享的此刻→共享的那时）─────────────────────
class TestWorldIntoSharedRefs(unittest.TestCase):
    def test_world_today_injected_into_prompt(self):
        msgs = build_understanding_prompt(
            UserProfile(user_id="u", character_id="c"),
            [{"role": "user", "content": "今天聊了杨梅"}],
            world_today=["XX限定杨梅季，酸到眯眼", "今天上海下大雨"])
        sys, user = msgs[0]["content"], msgs[1]["content"]
        self.assertIn("今天外面的真实世界", user)
        self.assertIn("杨梅季", user)
        self.assertIn("共同经历", user)
        self.assertIn("自然淡出", sys)   # Layer D 衰减提示也在系统prompt里

    def test_no_world_block_when_empty(self):
        msgs = build_understanding_prompt(UserProfile(user_id="u", character_id="c"),
                                          [{"role": "user", "content": "hi"}], world_today=None)
        self.assertNotIn("今天外面的真实世界", msgs[1]["content"])


# ───────────────────── Layer D：显著性 / 遗忘（shared_refs 封顶）─────────────────────
class TestSharedRefsDecay(unittest.TestCase):
    def test_cap_enforced(self):
        prof = UserProfile(user_id="u", character_id="c")
        many = [f"梗{i}" for i in range(30)]
        merge_profile(prof, {"relationship": {"shared_refs": many}})
        self.assertLessEqual(len(prof.relationship.shared_refs), 12)
        self.assertEqual(prof.relationship.shared_refs[0], "梗0")   # 保序、留前面（最鲜活）


# ───────────────────── 话题：维度扩容（池子更大）+ 每通轮换 + 防编造护栏 ─────────────────────
class TestTopicsBreadthAndRotation(unittest.IsolatedAsyncioTestCase):
    async def test_fetch_cap_raised_to_14(self):
        # 真实热点 20 条（无改写脑→真实标题原样），上限 14
        orig = wc.fetch_hot_items

        async def fake(*a, **k):
            return [{"title": f"真实热点{i}", "url": f"http://x/{i}"} for i in range(20)]
        wc.fetch_hot_items = fake
        try:
            out = await fetch_topics(None, datetime.datetime(2026, 6, 28, tzinfo=TZ))
        finally:
            wc.fetch_hot_items = orig
        self.assertEqual(len(out), 14)               # 上限 14
        self.assertTrue(all(o.get("url") for o in out))   # 每条都带原文链接

    def test_big_pool_samples_subset(self):
        pool = [f"话题{chr(0x4E00 + i)}" for i in range(12)]   # 12 个互不相同的中文话题
        line = _world_topics_line(pool)
        items = [x for x in line.split("）：")[-1].strip().split("；") if x.strip()]  # 取真正的话题段、按；切
        self.assertEqual(len(items), 8)                       # 大池每通只抽 8 条（不尬、不重样）
        self.assertTrue(set(items).issubset(set(pool)))       # 抽出来的都来自池子

    def test_small_pool_all_shown_with_safeguard(self):
        line = _world_topics_line(["杨梅季正火", "新番开播"])
        self.assertIn("杨梅季正火", line)
        self.assertIn("新番开播", line)
        self.assertIn("别咬死", line)           # A2 护栏：当模糊印象、不硬编细节
        self.assertIn("印象", line)

    def test_empty_pool(self):
        self.assertEqual(_world_topics_line([]), "")


if __name__ == "__main__":
    unittest.main()
