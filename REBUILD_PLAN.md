# PlayTop V2 重构计划(REBUILD_PLAN.md · Opinion 主链修正版)

> 状态:**已被"玩家视角重构(v4)"取代,本文档保留作架构审计档案**。
> **瘦身手术已执行(2026-06)**:V2 平行账本(provider_entity_map/match_snapshots/odds_snapshots/
> model_runs/report_versions/report_locks/settlements/track_records/audit_hashes 共 9 表,
> 含 /v2 页面、/api/v2 路由、analyze/settle 双写钩子)整体移除——全站单账本:
> analyses(哈希链+/verify)+ predictions(锁定/收盘/结算)+ outcomes。
> 保留 providers / raw_api_payloads / data_provider_health(原始留档与体检,合规铁律)。
> 迁移 0003_slim_dual_ledger 不可逆删除冗余账本数据(与 V1 完全重复,无信息损失)。
> 产品负责人最终裁定(2026-06):第一性原理 = 站在玩家视角解决其痛点。Opinion 表族方案不再实施——
> "观点"不需要独立表与状态机:**方向与评级来自 engine.picks,价格边界(最低可接受赔率)是发布时印出的静态派生值
> (margin/模型概率,engine.boundaryMargin 可配),锁定时收盘价低于边界的观点按观望计(不进战绩,审计留痕)**。
> 零新表,V2 首批表保留现状不再扩展。
> 已落地:玩家决策卡(方向+边界线+评级+论点)、首页观点流+信任条(近 30 天 ROI/命中/CLV)、战绩页玩家序
> (ROI 置顶+CLV 白话解释+锁定价 vs 收盘价)、锁定边界问责、合规词表清洗+测试防回流。
> 实时比价层(自抓当前价对比/趋势指示/临场加密刷新)经评估**砍掉**:玩家自己的平台就是实时价格来源,缺的只是边界线。
> 下文第 22 节 6 个待确认问题随方案废止,无需再回答。
> 核心修正(历史记录):**付费商品 = Opinion(赛前观点),Report 只是解释层**。上一轮 V2 MVP 把 report_versions 当成了商品载体——这是本计划要纠正的第一错误。

---

## 1. 当前项目现状

**技术栈**(逐层审计,全部胜任,无重写理由):
Next.js 15 App Router(前端+API 同进程)· Drizzle ORM + SQLite(better-sqlite3,迁移 0000-0002)· node-cron 进程内调度(4 任务)+ instrumentation 启动钩子 · 自建会话认证(scrypt+cookie)· 单容器 Docker 部署(香港 ECS,Caddy 反代,infra 仓库管脚本)。

**规模**:~13,000 行 TS;20 张表(V1 17 + V2 首批 12 中已建);36 个 API 路由;111 项测试 + 2 个端到端脚本(simulate / demo:wc)。

**已具备的能力**(资产):
- 数据中台:15 个零注册数据源适配器(ESPN/竞彩/Polymarket/Smarkets/Manifold/ClubElo/eloratings/Understat/martj42/openfootball/football-data/open-meteo 等),统一归一化 zod schema,健康账本连败自动停用,**原始响应已全量留档(raw_api_payloads,512KB 截断)**。
- 确定性引擎:Dixon-Coles MLE/矩估计/市场反推退化链、进球差 Elo、Shin 去水、多书商加权共识(因子权重+离群降权)、对数意见池、EV+¼Kelly、比分市场对照。纯函数、零随机、model_version 已记录、黄金值测试守护。
- 信任机制:研报 SHA-256 哈希链(prevHash)+ /verify 公开校验;V2 通用 audit_hashes 链 + 篡改检测测试;数字白名单(AI 违规数字→拒绝→降级模板)。
- 全自动流水线:赛程导入→采集→建模→发布→改版→锁定→赛果(CSV/ESPN 权威+AI 双确认)→结算→战绩,冷启动零人工。
- 积分:append-only 流水、原子解锁、作废退款、管理员操作留痕(audit_logs 记 operator)。

## 2. 当前最大结构问题(逐项实证)

| # | 审计项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 是否把 Report 当核心商品 | **🔴 是——这是头号建模错误** | V1:解锁授予的是"该场全部研报版本"的阅读权;V2 首批:report_versions 直接承载 free_preview/paid_content,商品=报告 |
| 2 | 是否没有 Opinion 层 | **🔴 没有** | "观点"以三种残缺形态散落:engine.picks(JSON 内嵌)、predictions(仅锁定时落库、无版本、无身份延续)、研报观点表格(纯展示) |
| 3 | 是否按 Match 结算而非按 Opinion | **🟡 半对半错** | predictions/settlements 行级是逐 pick 的 ✓,但结算入口、锁定、状态机全挂在 match 上;观点没有跨版本身份,无法回答"这个观点从 T72 到锁定改了几次" |
| 4 | Unlock 是否绑死某个 ReportVersion | **🟢 否(意外正确)** | V1 解锁就是 match 范围、覆盖全部赛前版本+终版,正是规约的 all_pre_kickoff_versions 语义;缺的只是 opinion 粒度与 initial_version 指针 |
| 5 | Report/Prediction/Pick/Opinion 概念混乱 | **🔴 是** | 四个概念横跨 6 个服务文件;analyses 同时是模型输出+报告+哈希节点 |
| 6 | 前端是否直连第三方 API | 🟢 否 | 全部经后端适配器 |
| 7 | 原始 payload 是否未保存 | 🟢 已修复 | politeFetchText 统一落 raw_api_payloads(成功+失败) |
| 8 | AI 是否参与计算 | 🟢 否 | 引擎零 LLM;数字白名单强制 |
| 9 | 战绩是否只统计有利样本 | 🟢 否 | 锁定终版全量结算、哈希链防删改;V2 track_records 已含 watch_only_count |
| 10 | 观望是否未进统计 | 🟡 半 | V2 已计数;V1 战绩页口径"观望不计分母"(作为口径明示,合规)但 V1 聚合未展示观望数 |
| 11 | 赌博化/喊单化文案 | **🟡 有残留** | 引擎 trace"N 个可下注选项"前台可见;"建议仓位(¼ Kelly)"措辞;需按第 20 节词表全量清洗为"模拟单位/风险刻度"口径 |

## 3. 可以保留的模块(直接复用,不重写)

- `src/server/engine/*` 全部数学(对应规约模型:加权共识=MarketConsensusModel、elo.ts=EloModel、dixonColes.ts=Poisson+DixonColes、adjustments.ts=FormAdjustmentModel、ensemble+picks=PlayTopConsensusModel 雏形)——**按规约输出契约重新包装,不重写算法**。
- `src/server/datasources/*` 15 源 + registry + sourceHealth + raw 留档(对应规约 Provider Adapter 的既有实现;Canonical* 类型即现有归一化 schema 的改名收口)。
- 哈希链/audit_hashes/verify、数字白名单、积分原子操作与流水、认证、自动化调度骨架、测试体系。
- V2 首批表中:providers / provider_entity_map / raw_api_payloads / match_snapshots / odds_snapshots / model_runs / audit_hashes / data_provider_health / track_records——**与新规约字段一致或仅差少量列,沿用**。

## 4. 必须废弃或标记 legacy 的模块

| 模块 | 处置 |
|---|---|
| `analyses` 表与 V1 发布/解锁链路 | **legacy**:继续服务旧页面,不再扩展;新主链不写入 |
| `predictions` 表 | **legacy**:被 opinion_versions + opinion_settlements 取代 |
| V2 首批 `settlements` 表 | **deprecated**(你已明确):被 opinion_settlements 取代,保留不删 |
| V2 首批 `report_versions` | **改造沿用**:加 opinion_id / opinion_version_id 外键,降级为解释层 |
| V1 战绩聚合(stats.ts) | legacy;V2 战绩以 opinion_settlements 为事实源 |
| 前台违规措辞 | 清洗:"可下注选项"→"可评估点位"、"建议仓位"→"模拟单位(风险刻度)"等,按第 20 节词表全站扫描 |

## 5. PlayTop V2 唯一主链

```
API 原始数据(raw_api_payloads)
→ 标准化(Canonical*,provider_entity_map)
→ 多时间点快照(match_snapshots T72/T24/T6/T1/lineup/lock/post/manual + odds_snapshots)
→ 模型运行(model_runs:六模块组合,输入输出双哈希,确定性)
→ 观点版本(opinions + opinion_versions:市场/方向/盘口/参考赔率/最低可接受赔率/评级/风险/失效条件)
→ 解释报告(report_versions:观点的文字化,数字白名单)
→ 积分解锁(unlock scope = match|opinion,all_pre_kickoff_versions)
→ 开赛锁定(opinion_locks,开赛前 15 分钟,锁后只可追加 correction)
→ 赛后结算(opinion_settlements:win/lose/push/void/half_win/half_lose + pnl/roi/clv/brier)
→ 公开战绩(track_records 聚合缓存,观望计入)
```

## 6. 新数据库结构

**已存在且符合规约(沿用)**:providers(补 config_json 列)、provider_entity_map、raw_api_payloads、match_snapshots(snapshot_type 补 manual)、odds_snapshots(market_type 补 double_chance)、model_runs、audit_hashes、data_provider_health、track_records(补 half_wins/half_losses 列)。
**复用 V1 表映射**:leagues(补 tier/is_active)、teams(补 short_name 取 aliases[0])、matches(状态服务层映射)、users.points+pointTransactions(=user_points+point_transactions 语义,流水 type 改名映射 admin_grant→admin_add)、unlocks(**加列**:unlock_scope_type 默认 match、unlock_scope_id、initial_opinion_version_id、initial_report_version_id、access_policy 默认 all_pre_kickoff_versions——存量行语义不变)。
**新建(迁移 0003,附 0003_down.sql)**:
- `players`(id/team_id/name/position/country,来源 ESPN roster 落地)
- `opinions`(规约 §7.11 全字段;唯一约束:每场最多一条 primary)
- `opinion_versions`(规约 §7.12 全字段;version_hash 链)
- `opinion_locks`(规约 §7.14 全字段,含 final_report_version_id)
- `opinion_settlements`(规约 §7.15 全字段)
- `correction_records`(锁后纠错只追加:opinion_id/operator_id/diff_json/reason/created_at)
- `jobs` 任务表(name/payload/status/attempts/last_error/run_at——cron+job table 的 MVP 队列)

## 7. 新 API 结构

前台(规约 §21,全部新建于 /api/v2):picks、schedule、matches/:id、matches/:id/opinion、matches/:id/report、matches/:id/versions、track-record、me/points、me/unlocks、POST unlock(scope 化)。**未解锁响应裁剪在服务端完成:方向/盘口/赔率/概率字段直接不出现在 JSON 中**(上线检查 §24.3)。
后台:/api/admin/v2/*(规约清单全部),其中 create-snapshot/run-model/generate-opinion/generate-report/lock/settle 是把现自动化编排器拆成可单步触发的对象级动作。
现有 /api/v2/matches 等首批 5 路由:改造为读 opinion 主链;/api/v2/audit 保留(规约外加分项)。旧 /api/* 全部保留标 legacy。

## 8. 新前端页面结构(移动端 H5 优先,冷静工具风,沿用现双主题)

/v2/picks(精选:今日统计条 + 观点卡,未解锁隐藏方向/盘口/赔率/概率,只示评级/风险/锁定状态)· /v2/schedule(筛选:全部/热门/五大/已出观点/即将锁定/已完赛)· /v2/matches/:id(规约 §19.3 的 13 段顺序)· /v2/track-record(含观望数、强观点占比、按联赛/市场/评级/周期拆分、最大回撤、连败)· /v2/database(轻量资料)· /v2/me。旧页面保留,导航逐步切换。

## 9. 新后台管理结构

/admin/v2:赛事管理(七态看板)· 数据源健康(现因子表迁入+时间序列)· 模型运行(input/output hash+JSON 预览)· 观点版本 · 研报版本(白名单+AI 文案+diff)· 观点审核(发布/暂停/标异常/重生成;**禁止改模型数字**;人工改文案记 diff+operator_id)· 赛果结算 · 战绩 · 用户积分(留痕已有)· 系统审计(六类 hash 链校验)。

## 10. 新任务队列结构

保留 node-cron 触发器,新增 `jobs` 表实现幂等+重试+可观测(规约 §18):任务先入表(name+payload 去重键),执行器领取→执行→记结果;失败 attempts+1 可重试;后台任务页可查。任务清单按规约 11 项映射现有 tick 函数拆分(sync_fixtures_daily=现 sync_fixtures、create_scheduled_snapshots=新增 T 档触发、lock_opinion_before_kickoff=现锁定改为开赛前 15 分钟、其余对应改造)。

## 11. 新数据源接入结构(Provider Adapter)

统一接口 `ProviderAdapter`(fetchLeagues/fetchTeams/fetchPlayers/fetchFixtures/fetchMatchDetail/fetchStandings/fetchRecentResults/fetchLineups/fetchInjuries/fetchOdds/fetchResult,各自可选实现)+ Canonical* 返回类型(=现归一化 schema 收口改名)。现 15 源重组为适配器实现(ESPN 实现 fixtures/lineups/odds/result;竞彩/Smarkets/Polymarket/Manifold 实现 fetchOdds;…)。**预留 SportmonksAdapter/ApiFootballAdapter 接口位**(见 §22 待确认问题 1)。key 走环境变量、不进仓库、不出前端(现已满足:唯一的 key 是 apiyi,存 DB 设置)。

## 12. 新模型引擎结构

现引擎重组为规约六模块(算法零改动,接口重排):MarketConsensusModel(=consensus.ts,proportional 去水为默认、Shin 为既有增强 ✓ 已超规约)· EloModel(=elo.ts)· PoissonScoreModel+DixonColesModel(=dixonColes.ts 拆出两档输出)· FormAdjustmentModel(=adjustments.ts 扩:赛程密度/首发)· PlayTopConsensusModel(=ensemble+picks 重写输出契约为规约 §11.6 JSON:primary_opinion/probabilities/top_scores/model_breakdown/data_quality)。确定性五要求现已全部满足(同输入同输出/input_hash/output_hash/model_version/error_message)。

## 13. 新 Opinion 层设计(核心)

- ModelRun 成功 → OpinionGenerationService:有明确优势(edge≥阈值)→ primary opinion(必含 market_type/selection/line/reference_odds/min_acceptable_odds/rating/risk_level/invalidate_conditions,**必须绑定具体盘口,禁止"主队不败"式模糊方向**);无优势 → watch_only opinion(记录、计入统计、不作为强观点售卖)。
- 每场最多一个 primary(DB 唯一约束);secondary lean 仅展示。
- 同一 opinion 跨快照演化:新 model_run 与上版关键字段比对 → 变化则追加 opinion_version(version_no+1,change_reason_json 记录哪个输入变了),opinion.current_opinion_version_id 前移;方向被推翻 → 旧 opinion 状态 void+新 opinion(或同 opinion 换 selection 记 change_reason,**待确认问题 4**)。
- rating 标尺:A/A-/B+/B/C/W(W=观望),由 edge×model_consistency_score×数据质量映射,映射表进 engine config 可调。
- min_acceptable_odds = 公允概率盈亏平衡价上浮安全垫(如 fair_odds×1.02),低于此价观点自动标"价值消失"失效。

## 14. 新 Report 层设计

ReportGenerationService 输入(match/snapshot/model_run/opinion_version/odds_timeline/version_type)→ 输出规约十段结构(结果卡/概率卡/比分卡/核心理由≤3/风险≤3/失效条件/盘口变化/模型分歧/版本记录/审计信息)。AI 只读白名单内数字(numbers_whitelist_json 持久化已有),违规→重写→降级模板(现机制保留);report_versions 增加 opinion_id/opinion_version_id 外键,free_preview 只含合规预览字段。

## 15. 新积分解锁逻辑

复用现原子扣费;unlocks 加列扩展 scope(match|opinion)+access_policy(all_pre_kickoff_versions)+initial 指针。**Primary opinion 统一 1 积分**(配置化,见待确认问题 5);已解锁不重复扣;watch_only 免费可见(标"观望");赛后 final report 公开不消耗积分(现已如此)。未解锁 API 响应字段白名单见 §7。

## 16. 新锁定逻辑

开赛前 **15 分钟**(配置 lockBeforeKickoffMinutes,现为开赛时刻→改):创建 lock snapshot → final model_run → final opinion_version → final report_version → opinion_locks(六步一事务,幂等)→ opinion.status=locked。锁后 final 三元组不可覆盖(服务层拒绝+测试守护);纠错只能追加 correction_records(diff+operator+reason)。

## 17. 新结算逻辑

完赛 → 权威赛果(ESPN/CSV 已有)+ 收盘赔率(lock snapshot 内嵌)→ 读 final opinion_version → 按 market_type+selection+line 结算(1x2/亚盘四态含 quarter 半赢半输/大小/波胆/double_chance)→ opinion_settlements(settlement_result/pnl_unit/roi/clv/brier_score/settlement_hash)→ track_records 刷新 → final report 公开。现 settleAhDetailed/Brier/CLV 实现直接迁移;**结算主体从 match 改为 opinion**。

## 18. 新战绩统计逻辑

事实源 opinion_settlements,track_records 为聚合缓存(scope:global/league/market/rating/period;新增 rating 与 period 两维)。必展:总比赛数/发布观点数/**观望场次数**/强观点占比/A 级战绩/B 级战绩/命中率/ROI/CLV/Brier/最大回撤/**连续亏损**。观望计入、不美化、口径白纸黑字(现声明保留)。

## 19. 分阶段迁移计划(对应规约 §22 十阶段)

| 阶段 | 内容 | 现状起点 |
|---|---|---|
| 1 冻结 legacy | analyses/predictions/旧 settlements 标记 @deprecated,旧链路只维护不扩展 | 本计划确认后立即执行(纯注释+文档) |
| 2 V2 数据模型 | 迁移 0003:7 张新表+3 张表加列,附 down.sql | 12 张 V2 表已在,增量小 |
| 3 数据源中台 | ProviderAdapter 接口收口+Canonical 类型改名;players 落地 | 15 源/raw 留档/健康账本已在,重组为主 |
| 4 Snapshot+ModelRun | SnapshotService 规约五方法+manual 类型;模型输出契约改为 §11.6 JSON | 已在,改输出契约 |
| 5 Opinion 层 | opinions/opinion_versions+生成规则+版本演化 | **全新,本次核心工程量** |
| 6 Report 层 | report_versions 挂 opinion,十段结构重写 | 白名单/AI 管线已在 |
| 7 积分解锁 | unlocks 加列+scope 化+1 积分定价+响应裁剪 | 原子逻辑已在 |
| 8 锁定结算 | opinion_locks/opinion_settlements/correction+15 分钟锁 | 四态结算/CLV/Brier 已在,换主体 |
| 9 前台 V2 | 五页(picks/schedule/matches/track-record/me)+database 轻量 | 双主题/组件库已在 |
| 10 后台 V2 | /admin/v2 十菜单 | 工作台/因子表已在,重排+补对象页 |

## 20. 每阶段验收标准

1:全量测试绿+deprecated 标记齐;2:迁移上/下行各执行一次无损;3:任一源断网系统不崩+raw 留档可查;4:同 input_hash 双跑 output_hash 相等(测试);5:同一比赛 T24→T6 盘口变化产生 version_no=2 且 change_reason 指明盘口、每场仅一 primary(约束测试);6:白名单外数字注入→报告生成失败(测试);7:未解锁 API 响应不含 selection/line/odds/概率字段(测试)、解锁后可见后续版本(测试);8:锁后覆盖被拒(测试)+15 分钟自动锁+亚盘四态结算全过+watch 计入统计(测试);9:规约 §25 用户路径手工跑通;10:§25 后台路径跑通+§24 十二项检查单全过。

## 21. 主要风险点

1. **双链并行期数据一致性**:V1 链(analyses)与 V2 链(opinions)同时写,战绩两套口径——缓解:V2 上线即以 V2 为对外唯一口径,V1 页面标"旧版";切换窗口≤2 阶段。
2. Opinion 版本演化的边界(方向反转算新版本还是新观点)——见待确认问题 4,定错了会污染战绩口径。
3. SQLite 写放大(opinion_versions 每 30 分钟可能新增)——版本去重:关键字段(selection/line/odds±阈值/rating)未变不发版,沿用 stableEngineHash 思路。
4. 15 源无 Sportmonks 级 SLA,首发(lineup 档)覆盖依赖 ESPN summary 的公布时机——lineup 快照设“未公布”显式态,不阻塞锁定。
5. 合规清洗遗漏——上线检查 §24.12 做全站词表 CI 扫描(grep 进测试)。
6. 迁移期间旧解锁用户权益——unlocks 加列默认 match scope,存量权益自动等价延续。

## 22. 需要你确认的问题(回答后开工阶段 1-2)

1. **数据源主源**:规约建议 Sportmonks(主)+API-Football(备),两者均需付费 API key——与此前"零注册全自抓"约束冲突。**A. 采购 Sportmonks key**(我留好 Adapter 接口位,你提供 key)/ **B. 维持现 15 个零注册源为第一版主源**(接口同样收口,随时可插 Sportmonks)。我建议 B 先行,接口兼容 A。
2. **首批 V2 表处置确认**:settlements→deprecated(你已定);report_versions 加列沿用;unlocks 加列扩展而非新建 unlock_records 表(保积分原子逻辑,字段语义与规约 §7.19 一一对应)——是否同意"加列沿用"两处?
3. **锁定时点**:统一开赛前 15 分钟(可配置)。现为开赛时刻——确认改为 15 分钟?
4. **方向反转语义**:同一场比赛模型方向从"主 -0.5"变为"客 +0.5"时:A. 旧 primary 置 void、新建 primary(战绩里旧观点不结算,标 void);B. 同一 opinion 追加版本、以锁定时方向为准结算。**我建议 B**(观点身份=该场的 primary 席位,版本记录完整演化,锁定版定生死)——确认?
5. **定价**:primary opinion 统一 1 积分(现默认 10)——确认 1 积分起步?
6. **评级标尺**:A/A-/B+/B/C/W 六档(规约示例含 A-/B+)映射现 A/B/C/观望——确认六档?

---

*确认以上 6 问后,按阶段 1→2 开工(冻结标记 + 迁移 0003),严格按规约 §26 顺序推进,不跳步。*
