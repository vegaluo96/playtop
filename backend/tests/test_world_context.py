"""世界库：安全闸 + 天气拼装 + 城市清洗 + 时事话题过滤 + 批量刷新/读取（全站共享）。"""
import datetime
import json
import unittest

from micall.offline import refresh_world, topics_now, weather_for
from micall.offline.world_context import _is_safe, _weather_line, clean_city, fetch_topics
from micall.providers import StubLLM

NOW = datetime.datetime(2026, 6, 28, 12, 0)


class TestSafetyGate(unittest.TestCase):
    def test_allows_harmless(self):
        self.assertTrue(_is_safe("阴有小雨，12°C"))
        self.assertTrue(_is_safe("杨梅上市了，街上飘着香"))

    def test_blocks_sensitive(self):
        self.assertFalse(_is_safe("某地发生地震，多人遇难"))
        self.assertFalse(_is_safe("领导人发表重要讲话"))
        self.assertFalse(_is_safe("股市暴跌"))
        self.assertFalse(_is_safe(""))


class TestWeatherLine(unittest.TestCase):
    def test_compose(self):
        self.assertIn("多云", _weather_line("上海", 24, 2))
        self.assertIn("24°C", _weather_line("上海", 24, 2))

    def test_feel_cold_hot(self):
        self.assertTrue(_weather_line("漠河", 1, 0).endswith("挺冷"))
        self.assertTrue(_weather_line("吐鲁番", 35, 0).endswith("挺热"))

    def test_empty_when_no_data(self):
        self.assertEqual(_weather_line("X", None, -1), "")


class TestCleanCity(unittest.TestCase):
    def test_strips(self):
        self.assertEqual(clean_city("现居上海"), "上海")
        self.assertEqual(clean_city("上海·徐汇"), "上海")
        self.assertEqual(clean_city("北京 朝阳区"), "北京")
        self.assertEqual(clean_city(""), "")


class TestTopics(unittest.IsolatedAsyncioTestCase):
    async def test_none_llm(self):
        self.assertEqual(await fetch_topics(None, NOW), [])

    async def test_filters_unsafe(self):
        llm = StubLLM([json.dumps(
            {"topics": ["杨梅上市了", "某地地震遇难", "新出的国漫挺好看"]}, ensure_ascii=False)])
        out = await fetch_topics(llm, NOW)
        self.assertIn("杨梅上市了", out)
        self.assertIn("新出的国漫挺好看", out)
        self.assertNotIn("某地地震遇难", out)   # 安全闸滤掉

    async def test_garbage(self):
        self.assertEqual(await fetch_topics(StubLLM(["不是 JSON"]), NOW), [])


class TestRefreshAndRead(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_fills_shared_store(self):
        # 天气走 open-meteo(网络)，测试里不触网 → weather 抓不到没关系；这里验【话题】共享 + 读取按天。
        llm = StubLLM([json.dumps({"topics": ["端午粽子上市", "新番开播"]}, ensure_ascii=False)])
        res = await refresh_world([], NOW, llm)            # 无城市 → 只拉话题
        self.assertEqual(res["topics"], 2)
        self.assertEqual(topics_now(NOW), ["端午粽子上市", "新番开播"])  # 全站共享、当天可读
        stale = datetime.datetime(2026, 6, 29, 12, 0)
        self.assertEqual(topics_now(stale), [])            # 跨天即过期，不串味
        self.assertEqual(weather_for("没拉到的城", NOW), "")  # 未抓到的城 → 空，降级季节推测


if __name__ == "__main__":
    unittest.main()
