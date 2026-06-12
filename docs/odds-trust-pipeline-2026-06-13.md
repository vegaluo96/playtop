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
  - 亚盘 line 必须是 0.25 单位且在 `-4.5..4.5`;
  - 大小球 line 必须是 0.25 单位且在 `0.5..8.5`;
  - 胜平负必须三项完整且满水率在合理区间。
- `/odds/live` 胜平负只接受 `Fulltime Result` / `Match Winner` / 精确 `1x2`,不再模糊吃 `1x2 - 80 minutes`。
- `main` 标记只作为滚球主盘口候选加分项,不再绝对覆盖水位更均衡、满水率更合理的盘口线。
- 新增 `diagnostic_issues` 诊断表与后台“盘口适配诊断”列表,记录 endpoint、fixture、bookmaker、bet、raw/parsed、错误类型和原因。
- prematch `/odds` 与 live `/odds/live` 使用独立 adapter 入口:赛前可按 bet id/name 双保险识别,滚球不使用赛前 bet id。
- 用户展示层过滤历史脏帧:
  - 首页列表;
  - 详情 summary/liveOdds;
  - 胜平负走势图;
  - 历史报价抽屉;
  - 用户端异动流。
- 如果滚球胜平负最新帧不可信,不回退展示赛前欧盘,避免把“当前值”变成陈旧值。

## 设计原则

API-Football 是原材料,不是产品答案。ZSKY 的展示链路必须是:

`原始 API 数据 -> fixture/bookmaker/bet 映射 -> values 解析 -> market 归类 -> line/双边完整性 -> 主盘口选择 -> 可信度门禁 -> 用户展示`

赛前 `/odds` 与滚球 `/odds/live` 必须分 phase 保存和展示;`/odds/bets` 与 `/odds/live/bets` 的 ID 体系不能混用。滚球没有历史,走势只能来自 ZSKY 自己的实时快照归档。

## 后续 OPEN

- 为每个展示 market 输出 `confidence` 和 `reason`,前端可显示“高可信/可信/一般/暂不展示”。
- 主盘口选择继续从“单书商主源优先”升级到“bookmaker 覆盖数 + 一级公司权重 + 水位均衡 + 更新时间”的评分模型。
- 异动等级从单市场阈值升级为 S/A/B/C:三盘共振、多家主流确认、单市场明显变化、单家公司观察。
- 生成统一 `MarketOverview`,让首页、详情、报告页共享同一个盘口总览 payload。
