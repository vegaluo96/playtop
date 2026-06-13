# Claude Handoff - PlayTop / ZSKY Data Fitting Chain

> 📌 历史/交接记录:数据口径规范已统一到 `docs/data-contract.md`(唯一规范)。本文件保留为**拟合链路交接与变更记录**;规则本身以规范为准。

更新时间: 2026-06-13 Asia/Shanghai

本文件给 Claude 或其他接手机器人使用。请先读完本文件，再读根目录 `AGENTS.md`、`HANDOFF.md`、`docs/af-coverage.md`。

## 1. 当前项目状态

- 项目路径: `/Users/vega/Documents/Codex/playtop-zsky-copy`
- 当前分支: `main`
- 当前 HEAD: `71e7020 修复欧指缺字段导致页面打不开`
- upstream: `origin/main`
- 本地 HEAD 与 `origin/main` 同步: 是, `git rev-list --left-right --count @{u}...HEAD` 为 `0 0`
- 本轮修复是否已 commit: 否
- 本轮修复是否已 push: 否
- 是否已部署生产: 否
- 当前未提交文件:
  - `docs/CLAUDE_HANDOFF.md`
  - `scripts/worker.ts`
  - `src/app/api/predictions/route.ts`
  - `src/app/api/report/[id]/route.ts`
  - `src/server/views/report-signals.ts`
  - `src/server/views/source-coverage.ts`
  - `tests/platform/report-signals.test.ts`
  - `tests/platform/source-coverage.test.ts`

当前测试结果:

- `npm run typecheck`: 通过。沙箱内会因 `tsconfig.tsbuildinfo` 写入权限报 EPERM, 已用非沙箱方式通过。
- `npx tsc --noEmit`: 通过。
- `npm test`: 通过, 33 个测试文件, 215 个测试。
- `npm run build`: 通过, Next build 成功, standalone 静态资源已复制。
- `npm run selfcheck`: 已运行, 但本地环境失败项来自配置/服务缺失, 不是本轮代码回归:
  - AF key 未配置
  - 超级管理员未种子
  - worker 无心跳
  - 今日赛程 0 场
  - 本地 `http://127.0.0.1:3000` 未启动, API fetch failed

当前仍不能打开或不稳定的页面:

- 本轮没有发现 Next build 层面的页面打不开问题。
- “欧指打不开”在上一提交 `71e7020` 已修复。
- 本轮未做浏览器 smoke test, 因为任务聚焦 API/拟合链路, 且本地服务未启动。
- 生产未验证。需要部署后抽查:
  - `/`
  - `/match/<fixtureId>`
  - `/report/<fixtureId>`
  - `/predictions`
  - `/data`
  - `/admin` 的“分析报告管理”和“数据链路诊断”

## 2. 本轮修复内容

本轮目标是专项修复“用户端拟合数据链路”的可追踪性和口径, 不是 UI 重构。

已修问题:

- `/api/report/[id]` 原来不返回 `sourceCoverage`; 现在返回用户安全版 `sourceCoverage`。
- `/api/report/[id]` 现在返回 `sourceCoverageNeedsRebuild`, 用于标记报告生成后有新数据到达。
- `/api/report/[id]` 现在返回 `fittingScope`, 取值为 `preview` 或 `fullReport`。
- 方向信号 `DirectionSignal` 新增:
  - `sourceKind`: `prediction | marketDerived | marketOnly | model | mixed | open`
  - `derived`: boolean
- 盘口派生观点不再只是混在中文文案里, 现在 API 可以机器识别它是否为派生观点。
- `/api/predictions` 的已解锁卡片现在也返回用户安全版 `sourceCoverage`。
- `sourceCoverage` 遇到 Polymarket `skipped` 时不再吞掉原因。开赛后无赛前缓存会显示为“已开赛,没有可用的赛前预测市场快照”。
- worker 报告预生成由 `matchPanorama(fxId)` 改为 `matchPanorama(fxId, { deep: true, injuries: true, preKickoffOnly: true })`, 使预生成报告与解锁报告的拟合输入更一致。
- Polymarket 赛前预取窗口从 `T-120m / T-60m / T-5m` 扩展为:
  - `T-24h`
  - `T-6h`
  - `T-120m`
  - `T-60m`
  - `T-15m`
  - `T-5m`

改动文件和原因:

- `src/server/views/source-coverage.ts`
  - 新增 `PublicSourceCoverageItem` / `PublicSourceCoverage`。
  - 新增 `publicSourceCoverage()`。
  - 把后台诊断里的内部细节转换成用户端安全文案。
  - 保留 `used/missing/failed/stale/pendingReview` 状态, 但不暴露 API-Football、endpoint、worker 等内部词。

- `src/server/views/report-signals.ts`
  - 给方向信号添加 `sourceKind` 和 `derived`。
  - 用统一 helper 生成方向对象, 避免某些分支忘记带来源口径。
  - 目的: 防止“盘口派生观点”被前端或后续逻辑误解成真实预测。

- `src/app/api/report/[id]/route.ts`
  - 接入 `buildReportSourceCoverage()` + `publicSourceCoverage()`。
  - 返回 `sourceCoverage`、`sourceCoverageNeedsRebuild`、`fittingScope`。
  - 预览态仍不返回付费报告正文/方向/模型, 但可以知道数据源覆盖状态。
  - 未解锁时也读取 injuries 缓存, 但 `deep` 仍只在解锁态读取, 避免预览态触发过多低频增强源。

- `src/app/api/predictions/route.ts`
  - 已解锁卡片返回 `sourceCoverage`。
  - 未解锁卡片仍不返回付费方向细节。

- `scripts/worker.ts`
  - 报告预生成使用完整赛前拟合输入。
  - 扩大 Polymarket 赛前预取窗口, 减少开赛后因无赛前缓存而 skipped。

- `tests/platform/source-coverage.test.ts`
  - 增加公开覆盖状态测试。
  - 验证用户安全版 coverage 不暴露 `API-Football`、`endpoint`、`worker`。
  - 验证开赛后无 Polymarket 赛前快照时原因不丢失。

- `tests/platform/report-signals.test.ts`
  - 验证派生方向带 `derived=true`。
  - 验证真实混合输入方向带 `sourceKind=mixed` 且 `derived=false`。

影响范围:

- 用户端展示: 本轮主要是 API 新增字段, 没有大改 UI。现有页面不会因为新增字段改变布局。后续 UI 可以用 `sourceCoverage` 显示自然语言缺源原因。
- 后台诊断: 不破坏现有后台完整诊断。后台仍可看到内部诊断, 用户端只拿安全版。
- 数据抓取: 只调整 worker Polymarket 预取窗口和报告预生成的 `matchPanorama` 参数。
- 入库: 没有改 DB schema, 没有改 raw 入库结构。
- 报告生成: 预生成输入更接近解锁报告; LLM/report cache 逻辑未改。

## 3. 当前核心架构口径

必须继续遵守:

- AF/API-Football 是原材料, 不是产品答案。
- ZSKY 的产品链路是: 赔率原材料 -> 盘口结构化 -> 主盘口选择 -> 异动解释 -> 可信展示。
- 前端只能读平台 view model, 不应该直接读 API-Football odds 原始结构。
- prematch odds 和 live odds 不能混用:
  - prematch odds 来自赛前 `/odds`。
  - live odds 来自 `/odds/live`。
  - 两套 bet id 和 value 语义不能混用。
- 初盘 = 赛前最早有效主盘口。
- 即时 = 当前最新有效主盘口; 开赛后对应滚球盘。
- Polymarket 和 AF Predictions 是预测输入源, 不是最终答案。
- 没有真实数据不能用默认假数据兜底:
  - 不允许 33/33/33 假概率。
  - 不允许 0% 七维对比壳。
  - 不允许默认摘要伪装成模型结论。
  - 没有真实数据时只能显示“暂无数据 / 数据积累中 / 暂未公布 / 开赛后更新 / 样本不足”。
- 平台是足球数据资讯终端, 不提供博彩服务。文案不要出现投注建议、收益承诺。

## 4. 用户端拟合数据链路

当前实际链路:

1. 外部来源
   - AF raw:
     - fixtures
     - odds
     - odds.live
     - predictions
     - fixtures.events
     - fixtures.statistics
     - fixtures.lineups
     - fixtures.players
     - teams.statistics
     - injuries
     - players.topscorers / topassists / cards
   - Polymarket:
     - `gamma-api.polymarket.com/public-search`
     - 搜索双方英文名、别名、日期等。
   - 天气:
     - 当前为按需增强源, 有诊断, 但还没有稳定进入 report fitting。
   - 其他源:
     - 目前更多用于后台诊断/未来扩展, 用户端不能假装已参与模型。

2. raw/cache
   - AF raw 归档: `af_raw_payloads`
   - 赛前赔率快照: `odds_snapshots`
   - 滚球赔率快照: `live_odds_snapshots`
   - predictions 快照: `predictions_snapshots`
   - 赛事聚合缓存: `fixtures_cache.payload`
   - 低频增强源: `kv`
   - Polymarket 缓存: `kv` 中 `poly:fx:<fixtureId>:...`

3. adapter/parser
   - odds parser / normalize 负责把 AF 原始 odds 拆成:
     - market: `ah | ou | eu`
     - side
     - line
     - h/a/d
   - 关键风险: prematch bet id 和 live bet id 不能混用。

4. domain/main market/report fitting
   - `src/server/markets/overview.ts`
     - 生成 `MarketOverview`
     - 选择主盘口
     - 输出 public market overview
   - `src/server/views/report.ts`
     - `buildReportSummary()`
     - `buildReport()`
   - `src/server/views/report-signals.ts`
     - `buildReportSignals()`
     - `publicProbability()`
     - `publicComparison()`
     - `publicReportAdvice()`
     - 现在方向信号带 `sourceKind` / `derived`。

5. sourceCoverage
   - `src/server/views/source-coverage.ts`
   - 后台完整 coverage:
     - `buildReportSourceCoverage()`
   - 用户安全 coverage:
     - `publicSourceCoverage()`
   - 当前覆盖:
     - `afPredictions`
     - `polymarket`
     - `prematchOdds`
     - `liveOdds`
     - `lineups`
     - `injuries`
     - `standings`
     - `recentForm`
     - `statistics`
     - `events`
     - `weather`

6. view model
   - 详情/报告/报告列表大多基于平台 view model:
     - `MarketOverview`
     - `ReportSignals`
     - `SourceCoverage`
   - 赛事列表 `/api/matches` 仍有轻量旧链路, 没有完全迁移到统一 `MarketOverview` 诊断口径。

7. API
   - `/api/report/[id]`
     - 返回报告、概率、方向、模型、marketOverview、sourceCoverage。
   - `/api/predictions`
     - 已解锁卡片返回方向、模型覆盖、marketOverview、sourceCoverage。
   - `/api/match/[id]`
     - 详情页主 API, 仍需继续检查是否所有模块都消费统一 view model。
   - `/api/matches`
     - 赛事列表 API, 当前仍是重点待迁移风险点。

8. 前端页面
   - `/`
   - `/match/[id]`
   - `/predictions`
   - `/report/[id]`
   - `/data`
   - `/admin`

## 5. 已确认的关键风险

还没有完全迁到统一 view model 的页面/接口:

- `/api/matches`
  - 赛事列表仍走 `liveAwareSeriesBatch + marketCell` 轻量路径。
  - 它没有完整携带 `MarketOverview` 的质量分、warnings、sourceCoverage。
  - 风险: 首页盘口卡片和详情/报告的主盘口口径可能出现差异。

- 部分详情页模块
  - `detailView` 内仍有独立组装逻辑。
  - 需要继续确认指数、盘路、更多玩法、历史指数是否全部从统一结构读。

仍有旧逻辑:

- `predSummary()` 在没有 AF Predictions 时会从盘口生成“指数派生观点”。
  - 现在 `ReportSignals` 能标出 `derived=true`, 但前端 UI 尚未明确展示“这是行情观察,不是预测源”。
- `signals.model.coverage` 本质是“模型输入覆盖率”, 不是所有数据源覆盖率。
  - 用户端如果只显示“覆盖 xx%”, 仍可能被误解。

sourceCoverage 可见性:

- `/api/report/[id]`: 已返回用户安全版。
- `/api/predictions`: 已解锁卡片返回用户安全版。
- 后台数据链路诊断: 已有完整技术版。
- 用户端 UI: 尚未把 `sourceCoverage.reason` 系统性展示出来。

Polymarket:

- 仍可能 `skipped`:
  - 未解锁报告时不主动请求。
  - 已开赛且没有赛前缓存时会 skipped。
- 仍可能 `pendingReview`:
  - 搜到候选但 matchScore 不够。
  - 候选不是单场胜平负语义, 例如晋级、冠军、总进球。
- 本轮只是扩大赛前预取窗口, 没有新增人工确认 UI 或后台批量审核。

AF Predictions:

- 仍可能缺失:
  - 源端无覆盖。
  - 抓取时机未到。
  - 负缓存等待重试。
  - 本地/生产 worker 未运行或 key 配置异常。
- 没有 AF Predictions 时, 概率不会用 33/33/33 兜底。
- 但盘口派生方向仍可能出现, 需要 UI 明确标为“指数派生/行情观察”。

默认派生观点风险:

- 已有 `derived` 字段, 但用户端尚未充分使用。
- 下一步必须避免把派生观点文案写成“AI 预测命中/模型预测”。

## 6. Claude 接手建议

先读文件:

1. `AGENTS.md`
2. `HANDOFF.md`
3. `docs/af-coverage.md`
4. `docs/af-data-chain-audit-2026-06-13.md`
5. `docs/odds-trust-pipeline-2026-06-13.md`
6. `src/server/markets/overview.ts`
7. `src/server/views/source-coverage.ts`
8. `src/server/views/report-signals.ts`
9. `src/server/views/report.ts`
10. `src/server/af/panorama.ts`
11. `src/app/api/report/[id]/route.ts`
12. `src/app/api/predictions/route.ts`
13. `src/app/api/matches/route.ts`
14. `src/server/external/polymarket.ts`
15. `scripts/worker.ts`

先跑命令:

```bash
git status -sb
git diff --stat
npm run typecheck
npx tsc --noEmit
npm test
npm run build
```

如果要跑自检:

```bash
npm run selfcheck
```

注意: `selfcheck` 依赖本地服务、AF key、管理员账号、worker 心跳。没有这些时失败不等于代码坏。

优先检查模块:

- P0:
  - `/api/report/[id]` 的 `sourceCoverage` 是否随真实数据变化正确。
  - `/api/predictions` 是否没有把派生观点当真实预测展示。
  - `/api/matches` 是否会和详情/报告主盘口口径不一致。
  - Polymarket 开赛前缓存是否真的在生产 worker 中落地。
  - AF Predictions 有数据时是否进入 `buildReportSummary()` 和 `buildReportSignals()`。

- P1:
  - 用户端报告 UI 展示 `sourceCoverage.reason`, 但不要暴露内部源名。
  - 把“覆盖 xx%”改成“模型输入覆盖 xx%”。
  - 首页赛事卡改为消费统一 MarketOverview 或至少携带同源诊断。
  - 后台报告管理跳转到单场数据链路诊断。
  - Polymarket pendingReview 人工确认入口。

- P2:
  - sourceCoverage 增加更细的 `displaySeverity`。
  - 天气进入 report fitting 前先建立稳定缓存和权重规则。
  - lineups/statistics/events 只在合理阶段参与报告, 不要赛前硬算。
  - 前端统一用 `sourceKind` 调整 badge/文案。

不要动的模块:

- 不要重写 AF 抓取核心。
- 不要改 DB schema, 除非先给 migration 和回滚策略。
- 不要把前端接回 AF raw payload。
- 不要把 prematch/live bet id 混成一套。
- 不要把 Polymarket 或 AF Predictions 当最终答案。
- 不要新增默认假概率、默认七维、默认摘要。
- 不要部署生产, 除非用户明确要求且已经 commit/push。

## 7. 测试命令和结果

本轮已运行:

```bash
npm run typecheck
```

结果: 通过。

```bash
npx tsc --noEmit
```

结果: 通过。

```bash
npm test
```

结果: 通过, 33 个测试文件, 215 个测试。

```bash
npm run build
```

结果: 通过。

补充说明:

- `npm run typecheck` 和 `npx tsc --noEmit` 在 Codex 沙箱内可能因为 `tsconfig.tsbuildinfo` 写入权限报 EPERM。非沙箱运行已通过。
- `npm run selfcheck` 非沙箱运行过, 但当前本地环境未配置 AF key、管理员、worker、本地服务, 所以失败项不作为本轮代码回归。

Smoke test 覆盖情况:

- 已覆盖:
  - TypeScript 编译
  - Vitest 单元/平台测试
  - Next production build
- 未覆盖:
  - 浏览器端移动端实际截图
  - 生产环境 API 抽样
  - 生产 PM2 worker 心跳
  - 真实 AF key 下的 predictions 抓取
  - 真实 Polymarket 赛前缓存落地

建议部署后 smoke:

```bash
curl -sS https://zsky.com/api/health
curl -sS 'https://zsky.com/api/matches?tz=UTC%2B8' | head -c 1000
curl -sS 'https://zsky.com/api/predictions?tz=UTC%2B8' | head -c 2000
curl -sS 'https://zsky.com/api/report/<fixtureId>?tz=UTC%2B8' | head -c 3000
pm2 status
pm2 logs playtop-worker --lines 80
```

部署命令参考:

```bash
cd ~/playtop && git pull origin main && npm install && npm run build && pm2 restart playtop-web playtop-worker
```

如果 PM2 进程名不一致:

```bash
cd ~/playtop && git pull origin main && npm install && npm run build && pm2 restart all
```

重要: 当前本轮修复尚未 commit/push, 因此以上部署命令只有在先 commit/push 后才会包含本轮代码。
