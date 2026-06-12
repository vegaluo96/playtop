# API-Football 字段覆盖矩阵(数据源 ↔ 用户端显示对齐)

> 第 46 条「全站深度检查:数据源与用户端显示是否对齐」的长期工作底稿。
> 状态:✅ 已显示 ｜ ⚙ 内部使用(调度/校验,不直接显示) ｜ ◐ 部分显示(缺漏已注明) ｜ ✖ 有意舍弃(注明原因)
> 防回归:`npm run selfcheck -- audit <fixtureId>` 做单场四层对照;本表随功能变更同步更新。
> 官方 API-Football v3.9.3:Endpoint 路径 38 条 + `/status` 共 39 条,`src/server/af/catalog.ts` 已逐条登记;本表描述的是**生产抓取/展示口径**,不是 catalog 登记本身。

| 端点 | 状态 | 显示面(手机 / PC / 后台) | 缺漏与说明 |
|---|---|---|---|
| status | ⚙✅ | 后台·系统设置(套餐/今日配额)+ 看板告警 | — |
| timezone | ✖ | — | 平台统一以 UTC 毫秒存储,用户时区由前端 prefs.tz 换算,无需该端点 |
| countries | ✖ | — | 联赛搜索结果已带 country 字段,单独国家列表无展示场景 |
| venues | ◐ | 详情·深挖「球场因素」(场名/城市/容量/草皮) | 容量/草皮依赖 bundle venue 字段,部分场馆 AF 缺数据 → 显示 — |
| leagues | ✅ | 后台·联赛搜索/添加;用户端 chips(经 cfg:leagues) | — |
| leagues.seasons | ⚙ | catalog/selftest 可测 | 生产抓取 season 主要来自 `/fixtures` 的 `league.season`,不依赖本端点 |
| teams | ◐ | 队徽(CDN 按 team id 直链)+ 队名(来自 fixtures/汉化层) | `/teams` 端点仅 catalog/selftest;成立年份/主场等球队资料暂未进 UI |
| teams.statistics | ✅ | 阵容「惯用阵型」+ 深挖**「赛季面板」**(总/主/客战绩、均进失、零封、连胜) | — |
| teams.seasons / teams.countries | ⚙ | catalog/selftest 可测 | 生产暂无展示场景 |
| standings | ✅ | 详情·技术面「积分榜」**完整榜单**(两队高亮;多组赛事自动取两队所在组) | — |
| fixtures | ✅ | 列表/详情头/比分/状态(含中场)/14 天日期带 | — |
| fixtures.rounds | ⚙ | catalog/selftest 可测 | UI 轮次来自 `/fixtures` 的 `league.round`,再由本地 `roundZh` 中文化 |
| fixtures.headtohead | ✅ | 详情·技术面「历史交锋」(满拉 10 场) | — |
| fixtures.statistics | ✅ | 详情·技术面「实时技术统计」**17 项全量**(含黄红牌/越位/扑救/传球成功率/禁区内外射门);half=true →「半场拆分」 | 无数据时常显「暂无数据」占位 |
| fixtures.events | ✅ | 详情·技术面「实时事件」(进球/牌/换人/VAR,球员名汉化) | — |
| fixtures.lineups | ✅ | 详情·阵容(球场图+球衣号+头像+替补席+教练;客队列序镜像) | 列向假设需真实滚球窗口对照官方阵容复核一次 |
| fixtures.players | ✅ | 详情·深挖「关键球员评分」(滚球实时评分优先) | — |
| injuries | ✅ | 详情·情报「伤停与情报」+ 报告人员小节 | — |
| predictions | ✅ | 预测页/详情概率条/AI 报告(胜率·七维·H2H·进球模型);缺方向时盘口推导 | — |
| sidelined | ✅ | 情报伤停 + **球员资料卡「伤停/停赛史」**(类型中文化+起止日期) | — |
| coachs | ✅ | 阵容主教练 + 深挖教练卡(上任年份/年龄/国籍/冠军数,汉化) | — |
| players / players.seasons / players.profiles / players.teams | ✅ | 头像 + 赛季评分 + **球员资料卡**(/api/player:出场/进球/助攻/牌/评分/可用赛季/效力球队,阵容与榜单点击打开,双端) | 球员卡优先展示赛季统计;无统计但有 profile 时仍展示基础资料 |
| players.squads | ✅ | 深挖「阵容深度」 | — |
| players.topscorers / topassists / topyellowcards / topredcards | ✅ | 详情·深挖「联赛榜单」**各榜前 5**(点击进球员卡) | — |
| transfers | ✅ | 详情·深挖「转会动态」 | — |
| trophies | ◐ | 深挖「战意/教练」显示现任教练冠军数 | 仅用 `trophies?coach=`,球员荣誉暂不展示 |
| odds | ✅ | 全部书商分页拉满落 `af_raw_payloads` + 兼容 `odds_raw`;主盘经质量门禁与 `MarketOverview` 归一化展示 1X2/亚盘/大小;百家对比/综合指数/列表三列 + **「玩法」tab**精选 10 类玩法 | “全量落库”不等于“全部 bet 全展示”;玩法 tab 为精选解析;低质量或串场 payload 只进 raw/DiagnosticIssue,不进主盘 |
| odds.mapping | ⚙ | catalog/selftest/af-probe 可测 | worker 不依赖本端点判定可用 fixture |
| odds.bookmakers / odds.bets | ⚙ | catalog/selftest/af-probe 可测 | 生产归一化按 id/name 双保险,未动态拉取玩法字典 |
| odds.live | ✅ | 滚球 raw 信封 + 实时盘卡 + 变化帧归档(live_odds_snapshots)→ 滚球走势/滚球异动/列表实时跳动 | 最新 live 帧不可信时不回退赛前盘或旧 live 帧,直接显示数据不足 |
| odds.live.bets | ⚙ | catalog/selftest/af-probe 可测 | 滚球生产解析当前只取 1X2/亚盘/大小主盘 |

## 已确认不存在的端点(不得伪造)
- 天气、裁判统计:AF v3 无对应端点(裁判姓名在 fixture.referee 字段,已显示于深挖「当值主裁」)。

## 复核清单(每次大版本跑一遍)
1. `npm run selfcheck -- audit <今日滚球场id>`:AF 原始 → 归一化 → 落库 → 显示 四层对照;
2. 真实滚球窗口:列表 3s 跳动 / 滚球异动入流 / 走势图滚球段生长 / 半场拆分出现;
3. 对照本表逐行抽查一个「✅」端点的实际显示;
4. 外部盘口校准:`npm run calibrate -- samples.json` 导入百度/足球财富/其它公开源样本,输出「外部盘口 vs PlayTop 归一化主盘」的 ✓/△/✗。
