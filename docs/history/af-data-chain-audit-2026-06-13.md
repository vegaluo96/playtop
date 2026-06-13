# AF 数据链路准确性检查与报告管理审计

> 📌 历史记录:规范已统一到 `docs/data-contract.md`(唯一规范)。本文件保留为**逐模块 PASS/WARN 审计快照**与 OPEN 清单;规则本身以规范为准。

日期:2026-06-13  
范围:AF 抓取、入库/缓存、归一化、服务端视图/API、用户端展示、后台诊断。  
结论:本轮未发现“前端直接消费 AF odds 原始结构”“赛前 bets 与滚球 bets 混用”“主盘口取第一条”的核心断点;确认缺口在后台逐场报告可观测性不足,本轮已新增“分析报告管理”。不宣称全站完全闭环。

## 模块链路

| 模块 | 状态 | AF endpoint | 入库/缓存 | 服务端输出 | 前端展示 | 无数据展示 | 审计结论 |
|---|---|---|---|---|---|---|---|
| 赛事列表 | PASS | `/fixtures`, `/odds`, `/odds/live` | `fixtures_cache`, `odds_snapshots`, `live_odds_snapshots` | `/api/matches`, `marketCell`, `liveAwareSeriesBatch` | `src/app/page.tsx` / 列表卡 | 暂无数据 / 数据积累中 | 列表不读 raw odds;主盘口来自归一化快照。 |
| 比赛详情指数 | PASS | `/odds`, `/odds/live` | `odds_raw`, `odds_snapshots`, `live_odds_snapshots` | `/api/match/[id]`, `detailView`, `MarketOverview` | `odds-workbench`, `quote-history` | 指数数据积累中 / 开盘后展示 | 初盘=本站归档首帧,即时=赛前末帧或当前主线,滚球另走 live 快照。 |
| 赛况事件 | PASS | `/fixtures/events`, `/fixtures` | `fixtures_cache.payload.events`, `kv fx:*:synthev` | `timelineView` | 详情·赛况 | 开赛后更新 / 暂无数据 | 独立详情端点合并进 payload;空返回写 DiagnosticIssue。 |
| 技术统计 | PASS | `/fixtures/statistics?fixture=`, half=true | `fixtures_cache.payload.statistics`, `kv fx:*:stats_half` | `liveStats`, `halfStats` | 详情·赛况/统计 | 开赛后更新 / 暂无数据 | 统计按 AF type 中文映射,过滤全零行;半场拆分独立缓存。 |
| 阵容/替补/教练 | PASS | `/fixtures/lineups`, `/coachs` | `fixtures_cache.payload.lineups`, deep KV | `lineupsView`, `intelView` | 详情·人员 | 暂未公布 / 数据积累中 | 人员名单与阵型分开展示;T-60min 内按需补齐。 |
| 球员数据 | WARN | `/players`, `/players.profiles`, `/players.seasons`, `/players.teams`, `/sidelined`, `/fixtures/players` | 球员 API KV, `fixtures_cache.payload.players` | `/api/player/[id]`, `deep` 视图 | 球员详情弹层/深度榜单 | 暂无数据 / 数据积累中 | 静态球员资料已缓存,但属于点开后冷缓存链路;建议后续对热门球员预热。 |
| 积分榜 | PASS | `/standings` | `kv data:*:standings`, 详情 deep KV | `/api/data`, `dataCenterView`;详情 `standings` | 数据页·积分 / 详情深度 | 暂无数据 / 暂未公布 | 数据页按组展示,赛程可跳转;不再展示内部“官方返回”字样。 |
| 射手榜/助攻榜 | PASS | `/players.topscorers`, `/players.topassists` | `kv data:*:scorers/assists`, deep KV | `/api/data`, deep league boards | 数据页榜单 / 详情深度 | 榜单尚未公布或样本积累中 | AF 有榜单时可展示;空榜单不伪造。 |
| 赛程 | PASS | `/fixtures` | `fixtures_cache` | `/api/data`, `dataCenterView` | 数据页·赛程 | 暂无赛程数据 / 暂未公布 | 数据页支持轮次切换和点击比赛。 |
| AI 概率报告 | WARN | `/predictions`, `/odds`, `/standings`, `/fixtures/*`, injuries, deep, Polymarket | `predictions_snapshots`, `odds_snapshots`, `report_cache`, `report_versions`, KV | `/api/predictions`, `/api/report/[id]`, 新增 `/api/admin/reports` | 报告页/预测页/后台报告管理 | 概率快照积累中 / 暂无数据 | 用户端已有开赛锁定;本轮补齐后台逐场输入诊断。增强源成功无统一 facts 表仍标 WARN。 |
| 异动 | PASS | `/odds`, `/odds/live` | `movements` | `/api/moves` | 异动页 | 暂无异动 / 数据积累中 | 异动只由真实快照差分生成;无变化不生成事件。 |
| 盘路/历史指数/更多玩法 | WARN | `/odds`, `/odds/live` | `odds_raw`, `odds_snapshots`, `live_odds_snapshots`, `model_records` | `quoteHistory`, `parseExtraMarkets`, `settleFixture` | 详情·走势/对比/盘路/更多玩法 | 快照积累中 / 暂无数据 | 历史报价最新在上;更多玩法读 `odds_raw` 解析,不进入主盘。早期样本薄仍属 WARN。 |

## 关键核查结果

- PASS:前端没有直接读取 AF odds 原始结构;用户端通过 `/api/matches`、`/api/match/[id]`、`/api/moves`、`/api/data` 获取服务端视图模型。
- PASS:赛前 `/odds` 与滚球 `/odds/live` 使用不同归一化入口;live bets 未与 prematch bet id 混用。
- PASS:`Home -0.5`、`Away +0.5`、`Over 2.5`、`Under 2.5` 在 `normalize.ts` 中解析为 side + line,并有诊断记录。
- PASS:主盘口不是取 AF 第一条,而是 `mainOddsDecisionFromRows` 按同线覆盖、主流书商、质量分选择。
- PASS:已有 `diagnostic_issues` 后台诊断表;本轮新增逐场报告诊断视图。
- WARN:Polymarket、天气等增强源目前主要通过 KV 与 DiagnosticIssue 留痕,缺少统一的 per-fixture 成功/失败事实表;后台已显式标出“未请求/未命中/无逐场成功快照表”。
- WARN:球员资料是低频静态缓存,但当前更多是点击后按需缓存;如要提升速度和节省 AF 调用,建议后续增加热门赛事球员预热任务。

## 本轮修复

- 新增后台菜单“分析报告管理”。
- 新增 `/api/admin/reports`:
  - 默认只读最近 7 天到未来 14 天比赛,不触发 AF/Polymarket/天气抓取。
  - 展示报告生成状态、版本、时间、模型、锁定状态、免费/解锁、输入源、缺失原因和诊断失败。
  - 手动“重新生成”会走既有报告链路,但开赛/完场锁定后拒绝重生成,不绕过回测规则。
- 导出 `REPORT_FACTS_VERSION`,让后台能看到报告事实指纹版本。

## OPEN

- 建议新增 `external_source_snapshots` 或类似表,把 Polymarket/天气/未来增强源的成功、缺失、错误都按 fixture 固化,避免只靠 KV key 与 DiagnosticIssue 推断。
- 建议新增球员静态资料预热任务:对今日/明日重点赛事的预计首发、榜单球员和详情页已出现球员提前缓存,减少首次点开延迟和 AF 调用。
- 外部真实同线同时间 AH / OU / 滚球盘口源仍需继续校准;本报告只审计 AF 内部链路与用户端展示,不把 AF 自校验当外部校准。
