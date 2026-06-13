# ZSKY / PlayTop 数据契约(单一规范)

> 版本:2026-06-13 · 状态:**唯一权威规范**。本仓库的数据口径以本文件为准。
> 历史审计与取证记录见 `docs/history/`(`odds-trust-pipeline-*`、`af-data-chain-audit-*`、`af-coverage.md`),它们解释「为什么有这些规则」,但**规则本身以本文件为准**。
> 接手先读:`AGENTS.md`(红线/纪律)→ 本文件(数据口径)→ `HANDOFF.md`(架构/技术债)。

本规范回答四个问题,任何改动必须能对照本文件验收:
1. 数据从 AF 原材料到用户屏幕,经过哪些层、每层的铁律是什么(§2–§4);
2. 每个用户可见的值,长什么形状、带什么元信息(§5 字段信封);
3. 后台和用户端看到的东西为什么必然一致(§6 双投影);
4. 哪个页面/路由必须消费哪个 view model、禁止做什么(§8),怎么自动核查(§9)。

---

## §0 不可违背的红线(摘自 AGENTS.md,本规范继承)

- 平台只提供体育数据资讯与分析,**不提供任何形式的投注/博彩服务**。
- **绝不伪造数据**:无真实变化不跳数;AF 没有的端点不得编造;拿不到的整块隐藏或如实标注。
- 仓库公开:**任何密钥/账号不得进代码或提交**。
- 用户端书商名必须经 `maskBookmaker` 打码。

---

## §1 源登记(AF 端点 → 表 → 覆盖键 → 管线落点)

数据源唯一:比赛数据 = API-Football v3(39 端点,`src/server/af/catalog.ts` 逐条登记);外部增强 = Polymarket(Gamma `public-search`)、天气(MET Norway + Open-Meteo)。**逐端点↔显示面的完整矩阵见 `docs/history/af-coverage.md`(附录,随功能同步)。** 本节给规范层的归并视图:

| 覆盖键(`SourceCoverageKey`) | 主要 AF 端点 | 落库/缓存 | 管线角色 | 是否参与报告拟合(`usedInReport`) |
|---|---|---|---|---|
| `prematchOdds` | `/odds` | `af_raw_payloads`(raw 信封)+ `odds_snapshots`(归一化)+ `odds_raw`(扩展玩法兼容) | 赛前主盘口 / 走势 / 百家 / 综合指数 / 异动 | ✅ 是 |
| `liveOdds` | `/odds/live` | `af_raw_payloads` + `live_odds_snapshots` + kv `fx:*:liveodds` | 滚球盘 / 实时跳动 / 滚球异动 | ✖ 仅赛中展示(报告赛前锁定) |
| `afPredictions` | `/predictions` | `predictions_snapshots` | 胜平负概率 / 七维 / 进球模型 / 近期状态 | ✅ 是 |
| `polymarket` | Gamma `public-search` | kv `poly:fx:*` | 预测市场增强信号(主/平/客) | ◐ 解锁报告参与;锁定预览不请求 |
| `lineups` | `/fixtures/lineups`(并入 `/fixtures?id=` bundle) | `fixtures_cache.payload.lineups` | 阵容/首发展示 | ✖ 仅追踪可用性,不量化为分值 |
| `injuries` | `/injuries` | kv `fx:*:injuries` | 伤停/情报 / 报告人员小节 | ✅ 是 |
| `standings` | `/standings`、`/teams/statistics` | kv `data:*`、deep kv | 积分榜 / 赛季面板 | ✅ 报告用赛季统计 |
| `recentForm` | `/predictions`(teams.form) | 随预测快照 | 近 6 场状态 | ✅ 是 |
| `statistics` | `/fixtures/statistics` | `fixtures_cache.payload.statistics`、kv `fx:*:stats_half` | 技术统计 / 半场拆分 | ✖ 仅赛中展示 |
| `events` | `/fixtures/events` | `fixtures_cache.payload.events`、kv `fx:*:synthev` | 赛况时间轴 | ✖ 仅赛中展示 |
| `weather` | MET Norway + Open-Meteo | kv `geo:*`、`wx:*` | 详情按需增强 | ✖ 尚未稳定进入拟合 |

**已确认不存在、不得伪造的端点**:天气、裁判统计(AF v3 无;裁判姓名在 `fixture.referee` 字段)。

诊断:任一源空返回/错误/串场/低质,统一写 `diagnostic_issues`(`source/endpoint/fixture_id/bookmaker_id/bet_id/raw/parsed/error_type/error_reason/severity/created_at`),不进主盘、不硬填用户端。

---

## §2 管线五段 + 接缝铁律

```
原始 API 数据
  → fixture/bookmaker/bet 映射
  → values 解析(Home -0.5 / Away +0.5 / Over 2.5 / Under 2.5 → side + line)
  → market 归类(ah | ou | eu)
  → line/双边完整性
  → 主盘口选择(§4)
  → 可信度门禁(§3)
  → 用户展示
```

接缝铁律(违反即事故):
- **F1 前端永不读 AF raw**:页面只消费平台 view model(`/api/matches`、`/api/match/[id]`、`/api/report/[id]`、`/api/predictions`、`/api/moves`、`/api/data`)。
- **F2 prematch / live 分 phase**:赛前 `/odds` 与滚球 `/odds/live` 用**独立 adapter 入口**;`/odds/bets` 与 `/odds/live/bets` 的 ID 体系**不能混用**。
- **F3 主盘口不得自取**:任何页面/路由禁止自己从 `odds_snapshots` 或 raw 挑主盘,只能用 §4 的决策结果。
- **F4 串场拒收**:AF 返回的 `fixture.id` 与目标不一致 → 只存 raw + DiagnosticIssue,不进 `odds_snapshots`。
- **F5 滚球无历史**:滚球走势只能来自 ZSKY 自有 `live_odds_snapshots` 归档,不得用赛前帧伪造滚球历史。

---

## §3 可信度门禁(`src/server/af/odds-quality.ts`)

凡进入用户展示的盘口帧,必须通过 `isDisplayableSnapshot`(赛前)/ `isDisplayableLiveSnapshot`(滚球):
- decimal odds ∈ `[1.01, 30]`;**滚球胜平负**用户展示额外收紧单项 ≤ `LIVE_EU_DISPLAY_MAX_ODD`(20),挡 `15/1.04/29` 这类源侧可疑帧;
- 亚盘 line:`0.25` 单位且 ∈ `[-4.5, 4.5]`;
- 大小球 line:`0.25` 单位且 ∈ `[0.5, 8.5]`;
- 胜平负:三项完整且满水率在合理区间;
- `main` 标记只作**主盘口候选加分项**,不绝对覆盖水位更均衡/满水率更合理的线;
- **赛前主盘序列 `qualityScore < 70` 不进入用户端主盘结果**;历史完场盘口不因时间旧被误杀(新鲜度只加分)。
- **最新滚球帧不可信时,不回退展示赛前盘或旧 live 帧**,直接显示数据不足(避免把"当前值"变成陈旧值)。

---

## §4 主盘口选择(`mainOddsDecision*` / `MarketOverview`)

唯一主盘口来源 = `src/server/markets/overview.ts` 的 `marketOverview()`,内部走 `mainOddsDecisionFromRows`:
1. 先 `filter(isDisplayableSnapshot)`(§3);
2. 每家书商取最新帧;
3. 亚盘/大小按盘口线覆盖数选候选;覆盖数接近时按主流书商权重、同线水位均衡、更新时间排序;
4. 返回 `MarketOverview`:`markets{ah|ou|eu:{series, source, qualityScore, books, selectedBooks, reason, warnings}}`、`dataQualityScore`、`lastUpdated`、`selectedReasons`、`diagnosticWarnings`。

**phase 边界(裁决)**:`MarketOverview.phase` **只有 `PRE_MATCH`**,是赛前主盘口标准结果;滚球主盘口走 `live_odds_snapshots` + `isDisplayableLiveSnapshot`,**不进 `MarketOverview`**。两套 phase 永不混用(F2)。当前不需要 live overview。

---

## §5 ⭐ 字段信封标准(用户可见值的统一形状)

**每一个下发给用户的"被拟合的值"(概率、方向、主盘口、洞察值……)统一成同一信封**,前端拿到即可回答「值多少 / 就绪没 / 谁给的 / 没有的话为什么」,不靠字符串匹配、不靠猜:

```ts
interface Fitted<T> {
  value: T | null;
  ready: boolean;                  // 取代散落的 probReady/summaryReady/comparisonReady
  source: "prediction"             // AF 模型直接给出
        | "model"                  // 平台模型计算(如综合指数)
        | "marketDerived"          // AF 缺失时由盘口派生(行情观察,非预测)
        | "mixed"                  // 多源加权
        | "market"                 // 来自盘口/预测市场(Polymarket)
        | "none";                  // 无可用来源
  reason?: string;                 // 缺失/降级的"用户安全"原因(来自 §6 publicSourceCoverage)
  asOf?: number;                   // 数据时点(ms)
}
```

**派生 vs 兜底的边界(裁决,踩红线那条)**:
- **禁止**默认假数据:`33/33/33` 假概率、`0%` 七维空壳、伪装成模型结论的默认摘要 —— 一律不允许。
- **允许**带来源标记的派生信号:`source: "marketDerived"`,但**必须** `ready: true` 且前端**显著标注"指数派生 / 行情观察"**,**绝不渲染成模型预测**。
- 无任何可用来源时:`value: null, ready: false, source: "none"`,前端显示「暂无数据 / 数据积累中 / 开赛后更新 / 样本不足」。

落地说明:`DirectionSignal` 当前仅有 `sources: string[]`(中文串),缺机器可读的来源标记 → 收口时按本信封补 `source`/`derived`,前端据此挂徽标(见 §10 待办)。

---

## §6 双投影(后台全量 / 用户安全,同源)

**同一次计算,两个可见度** —— 这是"后台与 UI 必然一致"的物理保证,不是两套算法:
- 主盘口:`marketOverview()`(全量,含书商名/警告)→ `publicMarketOverview()`(脱敏:质量分/覆盖数/选择原因/诊断警告,**不暴露书商名**)。已落地。
- 报告信号:`buildReportSignals()` → `publicProbability/publicComparison/publicReportAdvice`(带 `ready` 门控)。已落地。
- 源覆盖:`buildReportSourceCoverage()`(全量,**含 `API-Football/endpoint/worker` 等内部词,仅后台**)→ `publicSourceCoverage()`(剥离内部词,保留 `used/missing/failed/stale/pendingReview` + 安全原因)。**`publicSourceCoverage` 待补,报告/预测路由据此返回用户安全版**(见 §10)。

**安全原因标准文案**(用户侧 `reason`,不出现内部源名):
| 状态 | 含义 | 标准文案口径 |
|---|---|---|
| `used` | 已使用 | (不显示原因) |
| `missing` | 暂无数据 | 「暂无数据 / 数据积累中 / 尚未到抓取窗口 / 源端暂无覆盖」 |
| `failed` | 抓取失败 | 「数据源暂不可用,稍后重试」(不暴露端点名) |
| `stale` | 报告生成后有新快照 | 「已有更新,等待自动重新生成版本」 |
| `pendingReview` | 命中但匹配度不足 | 「候选数据待人工确认,暂不计入」 |

---

## §7 信任与有效性铁律

- **AF 是原材料,不是产品答案。**
- **初盘(裁决 = 定义 2)**:`初盘 = 本站赛前归档窗口内、最早一帧通过质量门禁(§3)的主盘口`。
  - 与门禁自洽:凡展示给用户的值必须过门禁,初盘是展示值,故必须过门禁;低质首帧不得当初盘。
  - 代码已落地:`oddsSeries → mainOddsSeriesFromRows`(`qualityScore<70` 返回 `[]`)、`oddsCompare`(per-book filter)的首帧均为门禁后帧。**唯一待修**:`src/server/views/detail.ts` 内"初始=归档首帧"的注释口径需改为"最早有效主盘口"(§10)。
  - 诚实标注:AF 仅提供赛前 14 天内赔率,真正开盘不可知 → UI 保留「自本站归档起,不冒充真实开盘」。
- **即时**:当前最新有效主盘口;开赛后对应滚球盘(经 §3 滚球门禁)。
- **无默认兜底**:见 §5。无数据只能用 §5 的空态文案。
- **不提供投注服务**:文案不得出现投注建议、收益承诺。

---

## §8 消费契约(谁读什么 / 禁止什么)

| 路由 | 必须消费 | 禁止 | 现状 |
|---|---|---|---|
| `/api/matches` | 主盘口经 `mainOddsSeriesFromRows` + 门禁(`marketCell`/`liveAwareSeriesBatch`) | 读 raw;自挑主盘 | ✅ 选盘已统一;◐ **未携带 `dataQualityScore/selectedReasons` payload**(§10) |
| `/api/match/[id]` | `detailView` + `MarketOverview` | 读 raw;重算主盘 | ✅ |
| `/api/report/[id]`、`/api/predictions` | `buildReportSummary` + `ReportSignals` + `publicMarketOverview` | 自行批量取序列生成方向;返回内部源名 | ✅ 概率/方向/marketOverview;◐ **未返回 `publicSourceCoverage`**(§10) |
| `/api/moves` | `movements`(真实快照差分) | 无变化生成事件 | ✅ |
| `/api/data` | `dataCenterView` | 读 raw | ✅ |

通用禁止:F1–F5(§2);前端字符串匹配判断来源(应读 §5 `source` 字段)。

---

## §9 一致性核对(怎么验证"符合契约")

- 盘口四层保真:`npm run selfcheck -- audit <fixtureId>`(AF 原始 → 归一化 → 落库 → 显示)。
- 批量主盘校验:`npm run selfcheck -- verify`。
- 外部校准:`npm run calibrate:public -- docs/external-odds-samples-*.json`(外部公开源 vs 平台归一化主盘)。
- 三件套门槛:任何改动 `npx tsc --noEmit && npm test && npm run build` 三绿方可进 main(AGENTS.md)。
- **待建**:per-路由契约检查(是否消费 view model、是否带 §5 信封),接入 selfcheck(§10)。

---

## §10 待办 backlog(追踪项,**非规范**;来自历史审计 OPEN/WARN + 本次收口)

> 以下是"尚未达成契约"的工作项,完成一项即从此处划掉。它们不是规则,是规则与现状的差距。

1. **§5 字段信封**:`DirectionSignal` 补 `source`/`derived`,前端方向挂「指数派生/行情观察」徽标。(红线相关,优先)
2. **§6 用户覆盖**:新增 `publicSourceCoverage()`,`/api/report/[id]` 与 `/api/predictions` 返回用户安全版;`覆盖 X%` 文案改「模型输入覆盖 X%」。
3. **§7 初盘注释**:`src/server/views/detail.ts` 注释"初始=归档首帧" → "最早有效主盘口"(代码行为已对)。
4. **§8 列表质量 payload**:`/api/matches` 在不拖慢前提下补 `dataQualityScore/selectedReasons`。
5. **外部源事实表**:新增 `external_source_snapshots`,把 Polymarket/天气的 per-fixture 成功/缺失/错误固化,替代靠 kv+DiagnosticIssue 推断。
6. **Polymarket 预取窗口**:worker 现仅 `T-120m/60m/5m`,扩 `T-24h/T-6h/T-15m`,减少开赛后无赛前缓存而 skipped。
7. **worker 预生成对齐**:报告预生成 `matchPanorama(fxId)` → 与解锁报告同款 `{deep, injuries, preKickoffOnly}`。
8. **异动分级**:单市场阈值 → S/A/B/C(三盘共振 / 多主流确认 / 单市场明显 / 单家观察)。
9. **mapping 后台化**:`prematch_bet_map/live_bet_map/bookmaker_map` 从代码内映射 → 后台可维护表 + parser replay。
10. **§9 契约检查**:per-路由"消费 view model + 带信封"自动核查接入 selfcheck。
11. **球员预热**:今日/明日重点赛事的预计首发/榜单球员提前缓存,减少冷启动延迟。
