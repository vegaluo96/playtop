"""世界库：安全闸 + 天气拼装 + 城市清洗 + 时事话题过滤 + 批量刷新/读取（全站共享）。"""
import datetime
import json
import unittest

import micall.offline.world_context as wc
from micall.offline import refresh_world, topics_now, weather_for
from micall.offline.world_context import _is_safe, _iter_hot_records, _weather_line, clean_city, fetch_topics
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


class TestHotRecords(unittest.TestCase):
    """从各热榜 API 的 JSON 深度抠出 {title,url}，平台名不当热点。"""

    def test_vvhan_shape(self):
        data = {"success": True, "data": [
            {"name": "douyin", "subtitle": "抖音", "data": [
                {"index": 1, "title": "杨梅季正火", "hot": "100w", "url": "http://d/1", "mobilUrl": "http://m/1"}]}]}
        recs = list(_iter_hot_records(data))
        titles = [r["title"] for r in recs]
        self.assertIn("杨梅季正火", titles)
        self.assertNotIn("抖音", titles)        # name/subtitle(平台名) 不当热点
        self.assertEqual(next(r for r in recs if r["title"] == "杨梅季正火")["url"], "http://d/1")

    def test_imsyy_shape(self):
        data = {"code": 200, "name": "bilibili", "data": [
            {"title": "新番开播", "url": "http://b/1", "mobileUrl": "http://m/1", "hot": 50}]}
        recs = list(_iter_hot_records(data))
        self.assertEqual(recs[0]["title"], "新番开播")
        self.assertEqual(recs[0]["url"], "http://b/1")


class TestWikiParse(unittest.TestCase):
    """维基『历史上的今天』/『今日热门词条』解析（带真实词条链接）。"""

    def test_onthisday(self):
        data = {"selected": [
            {"text": "阿波罗11号成功登月", "year": 1969, "pages": [
                {"title": "阿波罗11号", "content_urls": {"desktop": {"page": "https://zh.wikipedia.org/wiki/阿波罗11号"}}}]}]}
        out = wc._parse_wiki_onthisday(data)
        self.assertEqual(out[0]["title"], "1969年的今天，阿波罗11号成功登月")
        self.assertIn("阿波罗11号", out[0]["url"])

    def test_mostread(self):
        data = {"mostread": {"articles": [
            {"normalizedtitle": "某热门词条", "extract": "这是简介。", "views": 12345,
             "content_urls": {"desktop": {"page": "https://zh.wikipedia.org/wiki/X"}}}]}}
        out = wc._parse_wiki_mostread(data)
        self.assertIn("某热门词条", out[0]["title"])
        self.assertIn("zh.wikipedia.org", out[0]["url"])

    def test_empty(self):
        self.assertEqual(wc._parse_wiki_onthisday({}), [])
        self.assertEqual(wc._parse_wiki_mostread({}), [])


class TestFetchTopics(unittest.IsolatedAsyncioTestCase):
    """真实热点 → 安全闸 → grounded 改写；真实性来自数据源，LLM 只改写、不编。"""

    def setUp(self):
        self._orig = wc.fetch_hot_items

    def tearDown(self):
        wc.fetch_hot_items = self._orig

    def _stub_items(self, items):
        async def fake(*a, **k):
            return items
        wc.fetch_hot_items = fake

    async def test_safety_url_and_rewrite(self):
        self._stub_items([{"title": "杨梅季正火", "url": "http://a"},
                          {"title": "某地地震多人遇难", "url": "http://b"},
                          {"title": "新番开播", "url": "http://c"}])
        llm = StubLLM([json.dumps({"lines": ["刷到杨梅季正火", "看到新番开播"]}, ensure_ascii=False)])
        out = await fetch_topics(llm, NOW)
        texts = [o["text"] for o in out]
        urls = [o["url"] for o in out]
        self.assertIn("刷到杨梅季正火", texts)            # grounded 改写
        self.assertNotIn("某地地震多人遇难", "".join(texts))  # 安全闸滤
        self.assertIn("http://a", urls)                  # 原文链接保留
        self.assertNotIn("http://b", urls)

    async def test_no_llm_uses_real_titles(self):
        self._stub_items([{"title": "杨梅季正火", "url": "http://a"}])
        out = await fetch_topics(None, NOW)              # 没改写脑 → 真实标题原样（仍真实）
        self.assertEqual(out[0]["text"], "杨梅季正火")
        self.assertEqual(out[0]["url"], "http://a")

    async def test_rewrite_mismatch_falls_back(self):
        self._stub_items([{"title": "A话题", "url": "u1"}, {"title": "B话题", "url": "u2"}])
        llm = StubLLM([json.dumps({"lines": ["只有一条"]}, ensure_ascii=False)])   # 条数不匹配
        out = await fetch_topics(llm, NOW)
        self.assertEqual([o["text"] for o in out], ["A话题", "B话题"])             # 回退真实标题

    async def test_empty_when_no_items(self):
        self._stub_items([])
        self.assertEqual(await fetch_topics(StubLLM([]), NOW), [])


class TestRefreshAndRead(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._orig = wc.fetch_hot_items
        self._snap = json.dumps(wc._WORLD, ensure_ascii=False)

    def tearDown(self):
        wc.fetch_hot_items = self._orig
        d = json.loads(self._snap)
        for k in ("date", "weather", "weather_hist", "topics", "topics_src"):
            wc._WORLD[k] = d[k]

    async def test_refresh_fills_shared_store(self):
        async def fake(*a, **k):
            return [{"title": "端午粽子上市", "url": "http://a"}, {"title": "新番开播", "url": "http://b"}]
        wc.fetch_hot_items = fake
        res = await refresh_world([], NOW, None)           # 无城市 → 只拉话题；无改写脑 → 真实标题
        self.assertEqual(res["topics"], 2)
        self.assertEqual(topics_now(NOW), ["端午粽子上市", "新番开播"])  # 全站共享、当天可读
        self.assertEqual(wc.world_snapshot(NOW)["topics_src"][0]["url"], "http://a")  # 带原文链接
        stale = datetime.datetime(2026, 6, 29, 12, 0)
        self.assertEqual(topics_now(stale), [])            # 跨天即过期，不串味
        self.assertEqual(weather_for("没拉到的城", NOW), "")  # 未抓到的城 → 空，降级季节推测


if __name__ == "__main__":
    unittest.main()
