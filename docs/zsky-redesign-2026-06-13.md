# ZSKY 重构方案:单场全量数据 + 自然语言算法构建器

> 定稿 2026-06-13。0→1 产品重做,复用现有 AF 后端。新窗口重构以本文件为准。
> 配套:`docs/data-contract.md`(数据契约)、`src/server/contract/registry.ts`(机器 SoT)。

## 第一性原理(四轮收敛后)

ZSKY **不替用户判断、不设计/硬编任何下注算法**。只做两件事:
1. 把 API-Football 关于**每一场**的全部信息,完整、干净、可机读地拿到并结构化(「把每场数据全部信息拿到」);
2. 用 AI 当**自然语言算法构建器**:用户用人话描述自己的下注条件(如「主队近5场全胜 + 降盘 + 客队核心伤停」),AI 翻译成对全量数据的结构化规则,做**单场判定 + 跨场筛选**。算法永远是用户自己的,我们只提供「全量数据 + 表达算法的 AI 接口」。

**放弃**(之前几版误入的方向):数据研究员向花哨终端、AI 报告售卖机/商品化/免费付费层/已购、我们自研的量化下注算法、PC 三栏终端。
**手机优先**;桌面直接复用移动页(冻结终端)。

## A. 现状可复用(已验证)

- AF 全量已入库 + worker 分层抓取:odds / odds.live / predictions / lineups / injuries / statistics / events / standings / teams.statistics / players(+评分/榜单)/ h2h / transfers / coachs / Polymarket / weather。
- 数据契约:`src/server/contract/registry.ts`(39 端点归属 + 路由字段)+ `docs/data-contract.md` + 双向机器核查(防漂移,已建)。
- **派生事实散落处**(将收敛为「特征面」):
  - `views/insights.ts`(盘路 / 凯利 / 同赔 / 疲劳 / 角球)
  - `views/report-signals.ts`(方向 / sourceKind / derived / coverage / 评分)
  - `views/composite.ts`(综合指数)
  - `movements` + `/api/moves`(变盘 + 已加 S/A/B/C 分级)
  - `predictions`(AF 胜率% / 七维 / 进球 / form / h2h)
  - `views/detail.ts`(技术统计 / 阵容 / 积分榜)
  - `views/source-coverage.ts`(数据源就绪)、`af/markets.ts`(扩展玩法)、`platform/weather.ts`
- LLM:`llm/client.ts` `chatComplete`;`llm/report.ts`(借鉴缓存/预算/版本/合规 prompt)。
- 组件:`ProbBar` / `SourceBadge` / `CoverageStrip` / `MarketCell` / `ui.tsx`。

## B. 核心一 · 单场全量「特征面」(把每场全部信息拿到)

**新建** `src/server/views/match-features.ts`:`matchFeatures(fixtureId) → MatchFeatures` —— 把上面散落的派生事实**收敛成一个完整、结构化、文档化的单场事实对象**(前端与 AI 规则共用)。每项 `{ value, ready, source }`。分组:

- **盘口**:主盘 ah/ou/eu(line + 水位 + 质量分 q)、初盘→即时、变盘列表 + 分级、综合指数、百家分歧/离散、Polymarket。
- **模型**:AF predictions(胜平负% / under-over / 进球上限 / 七维)、方向信号(sourceKind / derived)、coverage。
- **状态**:近 6 场 form、H2H(胜负/大小)、盘路(赢盘率/大球率)、同赔历史。
- **人员**:首发/阵型、伤停、关键球员评分、疲劳(休整天数/赛程密度)。
- **赛况(滚球)**:比分/时间/技术统计/事件时间轴/半场。
- **环境**:球场/天气/裁判。
- **数据完整度**:sourceCoverage(每源 used/missing + 原因)。

**口径**:全部走现有视图模型/契约,**不读 AF raw**;缺的如实标 `missing`(绝不伪造)。
**新增** `GET /api/match/[id]/features` + 注册进 `registry.ts`(契约防漂移)。同时导出**字段 schema**(字段名/类型/含义/取值域),供 AI 规则编译引用。

## C. 核心二 · 自然语言算法构建器

1. **NL→规则编译** `src/server/ai/rule-compiler.ts`:LLM 输入 = 用户自然语言条件 + MatchFeatures 字段 schema → 输出**结构化谓词 JSON**(AND/OR/比较/存在性,只引用 schema 字段)。LLM **只产规则不碰数值判断**(可复现/可缓存/可人工校验);无法映射 → 明确报「该条件无法对应现有字段」,不瞎编。
2. **规则求值/筛选** `src/server/ai/rule-eval.ts`(**纯函数,无 AI**):单场 → 命中/否 + 逐条件成立明细(可解释);跨场 → 批量求值返回命中场次。
3. **保存算法**:新表 `user_algorithms(id, user_id, name, nl_text, rule_json, created_at)`。
4. **API**:`POST /api/algo/compile`(NL→rule 预览)、`POST /api/algo/screen`(跑筛选)、`GET/POST/DELETE /api/algo`。
5. **AI 追问**:`POST /api/match/[id]/ask` —— 注入该场 MatchFeatures,LLM 只答事实/解释,不替决策(合规 prompt)。

## D. 手机版页面结构(极简)

底部导航:**今日 / 我的算法 / 滚球 / 战绩 / 我的**。

- **今日**:赛事列表;顶部「用我的算法筛选」→ 只剩命中场次 + 命中条件徽标;卡 = 数据入口卡(队名/时间/盘口现状/数据完整度/变盘分级),非商品卡。
- **我的算法**:自然语言输入 + 已存算法;输入 → 实时 compile 预览(翻译出的规则)+ screen(今日命中几场)。「用户构建自己算法」的载体。
- **单场详情** `/match/[id]`:**完整特征面**分组展示,每组可展开看全量;顶部「AI 追问」入口。
- **滚球**:进行中场次,5s 刷数据(**不调 AI**);实时特征面变化 + 关键事件;「用算法盯盘」命中提醒(二期)。
- **战绩**:不是包装,而是「我的算法历史命中」——保存算法在过去 N 天的命中/赛果(扩 `model_records` 思路做 per-algorithm 回测)。
- **我的**:设置/数据源就绪/LLM 配置。

## E. 砍 / 改造(去同质化)

- **砍**:`app/data` 数据中心页、`components/desktop/*` 三栏终端(冻结复用移动)、滚球雷达、报告售卖 UI。
- **改造**:insights/百家/凯利/同赔/盘路 不再做独立花哨页 → 作为 MatchFeatures 字段并入单场特征面 + 供算法引用;`llm/report.ts` 报告降级为可选「单场 AI 摘要」。

## F. MVP(只保留)

1. MatchFeatures 完整特征面 + `/api/match/[id]/features`(地基)。
2. 单场详情页(完整特征面)+ AI 追问。
3. NL 算法构建器:compile + 单场/跨场 eval + screen + 保存。
4. 今日页(列表 + 用算法筛选)。

**二期**:滚球盯盘命中提醒、per-algorithm 回测战绩、算法导出/API、事件触发。

## G. 0→1 开发流程(新窗口逐步执行,每步三绿 + 契约核查 + 截图)

- **S0 地基**:`npm run selfcheck -- verify` + 契约测试确认 AF 全量覆盖;列 MatchFeatures 所需字段 → 对照现有视图模型,缺的按契约补齐。
- **S1 特征面**:写 `match-features.ts` + 字段 schema;`/api/match/[id]/features` + 注册契约 + 单测(各组缺失口径)。
- **S2 单场页**:重写 `/match/[id]` 为完整特征面分组展示(复用现有组件)。
- **S3 规则引擎**:`rule-eval.ts`(纯函数 + 全分支单测)→ `rule-compiler.ts`(LLM NL→rule + schema 约束 + 失败兜底)→ `/api/algo/compile|screen`。
- **S4 我的算法页**:NL 输入 → compile 预览 → screen 命中;`user_algorithms` 表 + 增删存。
- **S5 今日页**:列表 + 「用算法筛选」接 screen。
- **S6 AI 追问**:`/api/match/[id]/ask`(注入 features + 纯事实/合规 prompt)+ 单场页入口。
- **S7(二期起步)**:滚球页 5s 数据刷新;per-algorithm 回测。

## H. 关键文件

- **新建**:`src/server/views/match-features.ts`、`src/server/ai/{rule-compiler,rule-eval}.ts`、`src/app/api/match/[id]/{features,ask}`、`src/app/api/algo/*`、今日/算法/滚球/战绩 页、`db.ts` 加 `user_algorithms`。
- **复用**:`contract/registry.ts`(新路由登记)、`views/{insights,report-signals,composite,detail,source-coverage}.ts`、`llm/client.ts`、`movements`/store、组件库。
- **冻结/砍**:`components/desktop/*`、`app/data`、独立 insights/odds-workbench/quote-history 页。

## I. 风险与口径

- **不伪造**:特征缺失如实 `missing`;LLM 只产规则/解释,**绝不产数值或编造命中**(红线)。
- **规则可信**:数值判定走纯函数 `rule-eval`(可复现/可测);AI 只「翻译 + 解释」;compile 结果对用户可见可改。
- **AF 完整性**:用已建的契约双向机器核查保证「全量」不漂移。
- **合规**:个人/数据工具定位,仍保留「不构成投注建议」声明 + 不伪造。

## J. 验证

- 单测:`rule-eval` 全分支、`match-features` 各组缺失口径、契约 registry 同步。
- 端到端:种子库 standalone + curl `/api/match/[id]/features`、`/api/algo/screen`(给 NL 条件看命中场次 + 逐条件明细)、`/api/match/[id]/ask`;playwright 截图 今日/算法/单场 页。
- `npm run selfcheck` 全绿(含 L3 契约双向核查)。
