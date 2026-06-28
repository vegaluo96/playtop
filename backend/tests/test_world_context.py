"""联网脑（现居地真实近况）：安全闸 + 抓取拼装 + 优雅降级。"""
import datetime
import json
import unittest

from micall.offline.world_context import _is_safe, fetch_world_context
from micall.providers import StubLLM

NOW = datetime.datetime(2026, 6, 28, 12, 0)


class TestSafetyGate(unittest.TestCase):
    def test_allows_harmless(self):
        self.assertTrue(_is_safe("阴有小雨，12°C，湿冷"))
        self.assertTrue(_is_safe("杨梅上市了，街上飘着香"))

    def test_blocks_sensitive_and_negative(self):
        self.assertFalse(_is_safe("某地发生地震，多人遇难"))
        self.assertFalse(_is_safe("领导人发表重要讲话"))
        self.assertFalse(_is_safe("股市暴跌"))
        self.assertFalse(_is_safe(""))   # 空串无意义=不安全


class TestFetch(unittest.IsolatedAsyncioTestCase):
    async def test_none_llm_returns_empty(self):
        self.assertEqual(await fetch_world_context("上海", NOW, None), "")

    async def test_empty_city_returns_empty(self):
        self.assertEqual(await fetch_world_context("", NOW, StubLLM(["{}"])), "")

    async def test_composes_and_filters_unsafe_topic(self):
        llm = StubLLM([json.dumps(
            {"weather": "阴有小雨，12°C，湿冷", "topics": ["杨梅上市了", "某地地震多人遇难"]},
            ensure_ascii=False)])
        out = await fetch_world_context("苏州", NOW, llm)
        self.assertIn("阴有小雨", out)      # 天气保留
        self.assertIn("杨梅", out)          # 安全话题保留
        self.assertNotIn("地震", out)       # 不安全话题被安全闸滤掉

    async def test_unsafe_weather_dropped(self):
        llm = StubLLM([json.dumps({"weather": "台风登陆，已致伤亡", "topics": []}, ensure_ascii=False)])
        out = await fetch_world_context("厦门", NOW, llm)
        self.assertEqual(out, "")           # 连天气都不安全 → 整条空，降级到季节推测

    async def test_garbage_returns_empty(self):
        self.assertEqual(await fetch_world_context("北京", NOW, StubLLM(["这不是 JSON"])), "")


if __name__ == "__main__":
    unittest.main()
