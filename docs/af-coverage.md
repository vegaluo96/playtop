# API-Football 字段覆盖矩阵(数据源 ↔ 用户端显示对齐)

> 第 46 条「全站深度检查:数据源与用户端显示是否对齐」的长期工作底稿。
> 状态:✅ 已显示 ｜ ⚙ 内部使用(调度/校验,不直接显示) ｜ ◐ 部分显示(缺漏已注明) ｜ ✖ 有意舍弃(注明原因)
> 防回归:`npm run selfcheck -- audit <fixtureId>` 做单场四层对照;本表随功能变更同步更新。

| 端点 | 状态 | 显示面(手机 / PC / 后台) | 缺漏与说明 |
|---|---|---|---|
| status | ⚙✅ | 后台·系统设置(套餐/今日配额)+ 看板告警 | — |
| timezone | ✖ | — | 平台统一以 UTC 毫秒存储,用户时区由前端 prefs.tz 换算,无需该端点 |
| countries | ✖ | — | 联赛搜索结果已带 country 字段,单独国家列表无展示场景 |
| venues | ◐ | 详情·深挖「球场因素」(场名/城市/容量/草皮) | 容量/草皮依赖 bundle venue 字段,部分场馆 AF 缺数据 → 显示 — |
| leagues | ✅ | 后台·联赛搜索/添加;用户端 chips(经 cfg:leagues) | — |
| leagues.seasons | ⚙ | worker 选定当季 season 参数 | — |
| teams | ✅ | 队徽(CDN 按 team id 直链)+ 队名(汉化层) | — |
| teams.statistics | ✅ | 详情·阵容「惯用阵型」+ 深挖均场数据 | — |
| teams.seasons / teams.countries | ✖ | — | 调度无需;赛季由 leagues.seasons 决定 |
| standings | ✅ | 详情·技术面「积分榜」(两队行,多组拍平) | 完整联赛榜单未展示(终端定位为对阵导向,有意只展示两队) |
| fixtures | ✅ | 列表/详情头/比分/状态(含中场)/14 天日期带 | — |
| fixtures.rounds | ⚙ | 轮次中文化(roundZh) | — |
| fixtures.headtohead | ✅ | 详情·技术面「历史交锋」(满拉 10 场) | — |
| fixtures.statistics | ✅ | 详情·技术面「实时技术统计」;half=true →「半场拆分」 | 无数据时常显「暂无数据」占位 |
| fixtures.events | ✅ | 详情·技术面「实时事件」(进球/牌/换人/VAR,球员名汉化) | — |
| fixtures.lineups | ✅ | 详情·阵容(球场图+球衣号+头像+替补席+教练;客队列序镜像) | 列向假设需真实滚球窗口对照官方阵容复核一次 |
| fixtures.players | ✅ | 详情·深挖「关键球员评分」(滚球实时评分优先) | — |
| injuries | ✅ | 详情·情报「伤停与情报」+ 报告人员小节 | — |
| predictions | ✅ | 预测页/详情概率条/AI 报告(胜率·七维·H2H·进球模型);缺方向时盘口推导 | — |
| sidelined | ◐ | 并入情报伤停 | 教练停赛单独维度未展示(数据稀疏,合并展示) |
| coachs | ✅ | 阵容主教练(汉化) | — |
| players / players.seasons / players.profiles | ◐ | 头像 CDN 直链 + 赛季评分(深挖) | 球员独立资料页未做(终端定位对阵导向,暂不规划) |
| players.squads | ✅ | 深挖「阵容深度」 | — |
| players.topscorers / topassists / topyellowcards / topredcards | ✅ | 详情·深挖「联赛榜单」四王 | — |
| transfers | ✅ | 详情·深挖「转会动态」 | — |
| trophies | ✖ | — | 荣誉柜与盘口决策无关,有意舍弃 |
| odds | ✅ | 全部书商分页拉满:走势/百家对比(初盘/即时,前台打码)/综合指数/列表三列 | 赛前 14 天窗口起持续归档 |
| odds.mapping | ⚙ | worker 校验可用 fixture 范围 | — |
| odds.bookmakers / odds.bets | ⚙ | 归一化层书商/玩法 id 对照 | — |
| odds.live | ✅ | 滚球实时盘卡 + 变化帧归档(live_odds_snapshots)→ 滚球走势/滚球异动/列表实时跳动 | — |
| odds.live.bets | ⚙ | 滚球玩法 id 对照 | — |

## 已确认不存在的端点(不得伪造)
- 天气、裁判统计:AF v3 无对应端点(裁判姓名在 fixture.referee 字段,已显示于深挖「当值主裁」)。

## 复核清单(每次大版本跑一遍)
1. `npm run selfcheck -- audit <今日滚球场id>`:AF 原始 → 归一化 → 落库 → 显示 四层对照;
2. 真实滚球窗口:列表 3s 跳动 / 滚球异动入流 / 走势图滚球段生长 / 半场拆分出现;
3. 对照本表逐行抽查一个「✅」端点的实际显示。
