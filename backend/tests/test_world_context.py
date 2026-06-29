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


class TestParseRss(unittest.TestCase):
    """RSS/Atom 订阅源解析（媒体源主力，免注册、全球可达）。"""

    def test_rss_item(self):
        xml = """<?xml version="1.0"?><rss version="2.0"><channel>
            <title>The Verge</title>
            <item><title>New phone launches today</title><link>https://x/1</link>
                  <description>&lt;p&gt;The flagship ships with a bigger battery and a brighter screen.&lt;/p&gt;</description></item>
            <item><title>Studio Ghibli film returns</title><link>https://x/2</link></item>
        </channel></rss>"""
        out = wc._parse_rss(xml)
        self.assertEqual([o["title"] for o in out], ["New phone launches today", "Studio Ghibli film returns"])
        self.assertEqual(out[0]["url"], "https://x/1")
        self.assertIn("bigger battery", out[0]["desc"])             # 抠出原文简介（喂改写脑→据真实内容说）
        self.assertNotIn("<p>", out[0]["desc"])                     # HTML 标签已剥掉
        self.assertNotIn("The Verge", [o["title"] for o in out])   # channel 标题不当条目

    def test_json_record_captures_desc(self):
        data = [{"title": "新框架发布", "url": "http://d/1", "description": "号称比上一代快 3 倍、内存省一半。"}]
        rec = list(wc._iter_hot_records(data))[0]
        self.assertEqual(rec["title"], "新框架发布")
        self.assertIn("快 3 倍", rec["desc"])                       # dev.to 式 description 也抠进来

    def test_atom_entry_href_link(self):
        xml = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
            <title>Ars</title>
            <entry><title>Mars rover finds new rock</title>
                   <link rel="alternate" href="https://a/1"/></entry>
        </feed>"""
        out = wc._parse_rss(xml)
        self.assertEqual(out[0]["title"], "Mars rover finds new rock")
        self.assertEqual(out[0]["url"], "https://a/1")             # Atom 取 link 的 href 属性

    def test_garbage_returns_empty(self):
        self.assertEqual(wc._parse_rss("not xml at all <<<"), [])
        self.assertEqual(wc._parse_rss(""), [])


class TestCategoryAndGarbage(unittest.TestCase):
    """领域标签（多元可检索）+ 垃圾改写闸（剔掉 '.'/'1%' 残渣）。"""

    def test_cat_for_by_source(self):
        self.assertEqual(wc._cat_for("https://pitchfork.com/x"), "音乐")
        self.assertEqual(wc._cat_for("https://www.eater.com/x"), "美食")
        self.assertEqual(wc._cat_for("https://dev.to/x"), "科技")
        self.assertEqual(wc._cat_for("https://unknown.example/x"), "生活")   # 兜底

    def test_cat_for_prefers_given(self):
        self.assertEqual(wc._cat_for("https://dev.to/x", "美食"), "美食")     # 改写脑给的优先
        self.assertEqual(wc._cat_for("https://dev.to/x", "瞎填的"), "科技")   # 非白名单 → 回退源

    def test_rewrite_prompt_carries_desc_for_grounding(self):
        # 改写脑收到【标题 + 原文简介】→ 据真实内容说，而非只看标题瞎编（用户："是否真看到原文")
        msgs = wc._rewrite_prompt([{"title": "Mars rover update", "url": "u",
                                    "desc": "It found unusual rock formations near the crater."}])
        blob = msgs[0]["content"] + msgs[1]["content"]
        self.assertIn("Mars rover update", blob)
        self.assertIn("unusual rock formations", blob)   # 简介进了 prompt
        self.assertIn("简介", blob)                       # 指令明确要据简介、不脑补

    def test_meaningful_drops_garbage(self):
        self.assertFalse(wc._meaningful("."))
        self.assertFalse(wc._meaningful("1%"))
        self.assertFalse(wc._meaningful("—"))
        self.assertFalse(wc._meaningful("100%"))          # 纯数字符号
        self.assertTrue(wc._meaningful("杨梅季"))
        self.assertTrue(wc._meaningful("New iPhone"))


class TestRollingPool(unittest.IsolatedAsyncioTestCase):
    """滚动话题池：多日去重并入 + 衰减(丢旧闻) + 封顶(遗忘最旧)。"""

    def setUp(self):
        self._snap = json.dumps(wc._WORLD, ensure_ascii=False)

    def tearDown(self):
        d = json.loads(self._snap)
        for k in ("date", "weather", "weather_hist", "topics", "topics_src"):
            wc._WORLD[k] = d[k]

    def test_merge_dedup_and_decay(self):
        now = datetime.datetime(2026, 6, 28, 12, 0)
        wc._WORLD["topics_src"] = [
            {"text": "旧闻A", "url": "u", "cat": "科技", "date": "2026-06-24"},   # 4 天前 → 衰减丢
            {"text": "近闻B", "url": "u", "cat": "音乐", "date": "2026-06-27"},   # 昨天 → 留
        ]
        wc._merge_topics([{"text": "新闻C", "url": "u", "cat": "美食", "date": "2026-06-28"},
                          {"text": "近闻B", "url": "u2", "cat": "音乐", "date": "2026-06-28"}], now)  # B 去重刷新
        texts = [t["text"] for t in wc._WORLD["topics_src"]]
        self.assertNotIn("旧闻A", texts)              # 超龄淡出
        self.assertIn("新闻C", texts)
        self.assertEqual(texts.count("近闻B"), 1)     # 去重（不重复堆叠）
        b = next(t for t in wc._WORLD["topics_src"] if t["text"] == "近闻B")
        self.assertEqual(b["date"], "2026-06-28")     # 新的覆盖旧的（刷新日期）

    def test_pool_cap(self):
        now = datetime.datetime(2026, 6, 28, 12, 0)
        wc._WORLD["topics_src"] = []
        big = [{"text": f"话题{i}", "url": "u", "cat": "科技", "date": "2026-06-28"} for i in range(200)]
        wc._merge_topics(big, now)
        self.assertLessEqual(len(wc._WORLD["topics_src"]), wc._TOPIC_POOL_CAP)   # 封顶遗忘


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

    async def test_translate_drop_unsafe_english_and_url(self):
        # 英文不安全内容【绕过中文关键词闸】(它只拦中文) → 全交给改写脑：翻译合适的、置空丢弃不安全的，URL 逐条对齐
        self._stub_items([{"title": "New Pixar movie tops box office", "url": "http://a"},
                          {"title": "Shooting leaves several dead", "url": "http://b"},   # 英文·不安全·中文闸拦不住
                          {"title": "杨梅季正火", "url": "http://c"}])
        llm = StubLLM([json.dumps({"lines": ["皮克斯新片票房登顶了", "", "刷到杨梅季正火"]}, ensure_ascii=False)])
        out = await fetch_topics(llm, NOW)
        texts = [o["text"] for o in out]
        urls = [o["url"] for o in out]
        self.assertIn("皮克斯新片票房登顶了", texts)        # 外文翻译成中文
        self.assertIn("刷到杨梅季正火", texts)
        self.assertEqual(len(out), 2)                    # 不安全的英文被改写脑置空丢掉
        self.assertIn("http://a", urls)                  # URL 与改写后逐条对齐
        self.assertNotIn("http://b", urls)

    async def test_no_llm_chinese_only(self):
        # 没改写脑：外文无法翻译/无法 vet → 丢；只留中文标题原样
        self._stub_items([{"title": "English headline only", "url": "http://en"},
                          {"title": "杨梅季正火", "url": "http://cn"}])
        out = await fetch_topics(None, NOW)
        self.assertEqual([o["text"] for o in out], ["杨梅季正火"])
        self.assertEqual(out[0]["url"], "http://cn")

    async def test_rewrite_mismatch_falls_back_chinese(self):
        self._stub_items([{"title": "A话题", "url": "u1"}, {"title": "B话题", "url": "u2"}])
        llm = StubLLM([json.dumps({"lines": ["只有一条"]}, ensure_ascii=False)])   # 条数不匹配
        out = await fetch_topics(llm, NOW)
        self.assertEqual([o["text"] for o in out], ["A话题", "B话题"])             # 回退中文真实标题

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
        self.assertTrue(wc.world_snapshot(NOW)["topics_src"][0]["cat"])               # 每条带领域标签
        # 滚动池：话题不按当天硬过期，多日滚动+衰减——次日仍在（旧闻还能聊），3 天后才淡出。
        nextday = datetime.datetime(2026, 6, 29, 12, 0)
        self.assertEqual(topics_now(nextday), ["端午粽子上市", "新番开播"])   # 跨天仍有一池
        stale = datetime.datetime(2026, 7, 2, 12, 0)       # +4 天 → 超 _TOPIC_AGE_DAYS，淡出
        self.assertEqual(topics_now(stale), [])
        self.assertEqual(weather_for("没拉到的城", NOW), "")  # 未抓到的城 → 空，降级季节推测


if __name__ == "__main__":
    unittest.main()
