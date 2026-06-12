# 盘口原材料到可信展示审计

日期: 2026-06-13

## 本次问题

Canada vs Bosnia & Herzegovina 滚球阶段,详情页胜平负一度展示 `251.00 / 9.50 / 1.05`。生产库确认该值已经进入 `live_odds_snapshots`,不是前端排版问题。

直接原因:

- `/odds/live` 胜平负只校验三项 `> 1`,没有 odds 上限、满水率、FT market 精确匹配。
- live 解析用 `/1x2/` 模糊匹配,存在把 `1x2 - 80 minutes` 等分钟段玩法误认为全场胜平负的风险。
- 列表、详情、历史、综合指数、异动流共用这批实时帧,但展示层没有二次质量门禁。

## 已落地修复

- 新增 `src/server/af/odds-quality.ts` 作为盘口质量门禁。
- 赛前与滚球核心市场统一拦截:
  - decimal odds 必须在 `1.01..30`;
  - 滚球胜平负用户展示额外收紧到单项 `<=20`,避免 AF live 端偶发 `15/1.04/29` 这类源侧可疑帧进入 summary/走势;
  - 亚盘 line 必须是 0.25 单位且在 `-4.5..4.5`;
  - 大小球 line 必须是 0.25 单位且在 `0.5..8.5`;
  - 胜平负必须三项完整且满水率在合理区间。
- `/odds/live` 胜平负只接受 `Fulltime Result` / `Match Winner` / 精确 `1x2`,不再模糊吃 `1x2 - 80 minutes`。
- `main` 标记只作为滚球主盘口候选加分项,不再绝对覆盖水位更均衡、满水率更合理的盘口线。
- 新增 `diagnostic_issues` 诊断表与后台“盘口适配诊断”列表,记录 endpoint、fixture、bookmaker、bet、raw/parsed、错误类型和原因。
- 后台“数据与模型监控”新增“主盘口决策”卡片,显示最近未完场样本的 `qualityScore`、覆盖数、主流书商覆盖、选择原因和警告。
- prematch `/odds` 与 live `/odds/live` 使用独立 adapter 入口:赛前可按 bet id/name 双保险识别,滚球不使用赛前 bet id。
- 赛前主盘口选择已从“单一主源/数组顺序”升级为多书商共识决策:
  - 先取每家书商最新帧;
  - 亚盘/大小按盘口线覆盖数选候选;
  - 覆盖数接近时按主流书商权重、同线水位均衡、更新时间排序;
  - 决策层返回 `qualityScore`、覆盖数、主流书商覆盖和选择原因,供后台/后续 ViewModel 披露。
- 用户展示层过滤历史脏帧:
  - 首页列表;
  - 详情 summary/liveOdds;
  - 胜平负走势图;
  - 历史报价抽屉;
  - 用户端异动流。
- 如果滚球最新帧不可信,胜平负/亚盘/大小都不回退展示赛前盘,避免把“当前值”变成陈旧值。

## 2026-06-13 数据治理续补

本轮继续补齐缺失的数据处理层,仍不宣称全站校准完成。

已新增/收紧:

- `af_raw_payloads` raw 信封表:保存 `endpoint/request_params/response_status/fixture_id/bookmaker_id/bet_id/parser_version/payload/fetched_at`,用于线上错盘回放。旧 `odds_raw` 保留给扩展玩法解析兼容。
- `/odds` 归档新增 fixture 串场检查:AF 返回的 `fixture.id` 与目标 fixture 不一致时只保存 raw 与 DiagnosticIssue,不进入 `odds_snapshots`。
- `/odds/live` worker 把原始响应也写入 raw 信封,不再只有 KV 和标准化 live 快照。
- `isDisplayableSnapshot` / `isDisplayableLiveSnapshot` 成为用户端共同展示门禁;赛前主盘、百家对比、首页、详情、历史报价均复用。
- 赛前主盘序列低于 `qualityScore < 70` 不进入用户端主盘结果;历史完场盘口不会仅因时间旧被误杀,新鲜度只作为加分项。
- `MarketOverview` 服务层已落地在 `src/server/markets/overview.ts`,输出核心三盘、质量分、选择原因、警告、最后更新时间。`matchPanorama` 已从该层读取赛前核心三盘,报告页/详情页共享同一标准结果。
- 后台 monitor API 增加 `rawAudit`,可看到当天 raw 信封按 endpoint 的计数与最近写入时间。
- 回归测试新增:
  - raw 信封保存;
  - fixture 串场拒收;
  - 低质量非主流单源盘口不进入主盘;
  - live AH/OU/EU 最新脏帧不回退赛前盘;
  - MarketOverview cutoff 锁定开赛前版本;
  - 坏行不进入百家对比。

## 设计原则

API-Football 是原材料,不是产品答案。ZSKY 的展示链路必须是:

`原始 API 数据 -> fixture/bookmaker/bet 映射 -> values 解析 -> market 归类 -> line/双边完整性 -> 主盘口选择 -> 可信度门禁 -> 用户展示`

赛前 `/odds` 与滚球 `/odds/live` 必须分 phase 保存和展示;`/odds/bets` 与 `/odds/live/bets` 的 ID 体系不能混用。滚球没有历史,走势只能来自 ZSKY 自己的实时快照归档。

## 后续 OPEN

- 将数据层 `qualityScore/reason` 接入用户端小字提示,前端可显示“高可信/可信/一般/暂不展示”。
- 异动等级从单市场阈值升级为 S/A/B/C:三盘共振、多家主流确认、单市场明显变化、单家公司观察。
- 首页列表目前仍走批量 helper,但已经复用同一主盘 selector 和展示门禁;下一步可把 `MarketOverview` 做成批量输出,让列表 payload 也显式带 `dataQualityScore/selectedReasons`。
- `prematch_bet_map`、`live_bet_map`、`bookmaker_map` 仍是代码内映射/权重,还不是后台可维护表。下一阶段需要做人工 mapping 修正与 parser replay。
