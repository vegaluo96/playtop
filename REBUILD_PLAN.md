# PlayTop 重构计划(REBUILD_PLAN.md)

> 架构师注:本文档基于对现有仓库的逐文件审计撰写。结论先行——**当前项目已经实现了你定义的核心闭环的约 80%,真正缺的不是"推倒重来",而是把领域模型显性化、把审计链补全、把前台体验收口。** 下文逐条对照你的 8 条重构原则给出证据与差距,再给分阶段方案。

---

## 一、当前项目现状

### 技术栈(建议沿用,理由见原则 8 对照)

| 层 | 现状 | 评估 |
|---|---|---|
| 前端框架 | Next.js 15 App Router(React 19,服务端组件) | ✅ 保留。SSR + force-dynamic 天然适配"赛前数据频繁变、赛后归档"的读多写少模型 |
| 后端框架 | Next.js Route Handlers(同进程)+ `src/server/*` 分层服务 | ✅ 保留。单体足够;服务层已与路由解耦,可独立测试 |
| 数据库 | SQLite(better-sqlite3,同步驱动) | ✅ 保留(单机)。⚠️ 见风险点:写并发与多实例水平扩展的上限 |
| ORM | Drizzle ORM + drizzle-kit 迁移 | ✅ 保留。schema 即类型,迁移已纳入版本管理(drizzle/0000、0001) |
| 任务队列 | **无外部队列**;`node-cron` 进程内调度 + `instrumentation.ts` 启动钩子 | ⚠️ 保留但需加固(见原则 7/风险点):进程内 cron 无分布式锁,多实例会重复执行 |
| 认证系统 | 自建会话(`sessions` 表 + cookie,`src/server/auth/*`,scrypt 密码) | ✅ 保留。够用,无需引入第三方 |
| 部署 | 单容器 Docker(standalone 输出),SQLite 挂卷,服务器本地构建,infra 仓库管脚本 | ✅ 保留。已在香港 ECS 跑通,Caddy 反代 |

代码规模:`src/` 约 12,500 行 TS/TSX;17 张表;31 个 API 路由;4 个 cron;104 项测试 + 2 个端到端脚本(`simulate` / `demo:wc`)。

### 现有功能盘点(对照你的清单)

| 功能 | 状态 | 位置 |
|---|---|---|
| 赛程 | ✅ 完整:openfootball 世界杯一键导入 + football-data CSV 联赛同步 + 手动建赛;冷启动自动导入 | `services/importWorldCup.ts`、`matchesService.ts` |
| 比赛页 | ✅ 前台研报三态(锁定/解锁/公开)+ "研报准备中"赛程态;后台工作台 | `app/(user)/matches/[id]`、`app/admin/matches/[id]` |
| 用户系统 | ✅ 注册/登录/会话/封禁 | `server/auth/*`、`app/api/auth/*` |
| 支付或积分 | ✅ 积分制(管理员人工充值,无自助支付);append-only 流水 + 原子解锁 + 作废退款 | `services/points.ts`、`unlock.ts`、`pointTransactions` 表 |
| 数据源接入 | ✅ 15 源中台:全部经 `src/server/datasources/*` 适配器归一,**前端零直连**;健康账本自动停用 | `datasources/*`、`services/sourceHealth.ts`、`registry.ts` |
| 模型逻辑 | ✅ 纯函数确定性引擎:Dixon-Coles / Elo / Shin 去水 / 加权共识 / 对数意见池 / EV+Kelly | `server/engine/*` |
| 研报逻辑 | ✅ 版本化 + SHA-256 哈希链 + 开赛锁定 + 赛后结算 + /verify 公开验证 | `services/publish.ts`、`settle.ts` |
| 后台管理 | ✅ 看板/比赛工作台/用户积分/系统设置(含因子表、自动化开关、引擎参数) | `app/admin/*` |

---

## 二、逐条对照"重构原则"——证据与差距

> 这是本文档最关键的部分:你的 8 条原则,现状满足到什么程度,差距在哪。

**原则 1(不做门户)——✅ 已满足。** 无社区/投稿/直播/资料库。产品面是"赛事卡片 → 研报 → 解锁 → 战绩"四屏,克制。**无需动作。**

**原则 2(第三方 API 不得前端直连)——✅ 已满足。** 全部第三方源在 `src/server/datasources/*` 适配器内抓取并归一,前端只调 `/api/*`。**无需动作。**

**原则 3(供应商预测只能当因子)——🟡 基本满足,需补一处。** Polymarket/Manifold/Smarkets 等预测市场进入的是 `odds` 快照(书商维度),由引擎做加权共识后才成为观点——它们是因子,不是直接包装。⚠️ 差距:`aiOdds.ts` 的 AI 检索盘口、未来可能接入的"第三方 prediction"需要一条明文红线——**任何 `probability`/`pick` 字段的外部源只能落到因子层,严禁直接写入 `analyses`**。当前没有源违反,但缺一个架构约束(类型层面禁止)。

**原则 4(系统核心是领域对象链,不是"研报")——🟡 概念已全有,但命名/边界未显性化。** 你要的对象链:
`Match → Snapshot → ModelRun → ReportVersion → LockRecord → Settlement → TrackRecord`
现状映射:

| 你的对象 | 现有载体 | 差距 |
|---|---|---|
| Match | `matches` 表 | ✅ |
| Snapshot | `dataSnapshots` 表(每 kind 多版本,内容哈希去重) | 🟡 见原则 6:**未存原始 payload** |
| ModelRun | 揉进了 `analyses.engineOutput`(引擎输出 JSON) | 🔴 **未独立成对象**:引擎输入 bundle 未持久化,无独立 model_run_id/耗时/输入指纹 |
| ReportVersion | `analyses` 表(version + status + contentHash + prevHash) | ✅ 强 |
| LockRecord | 隐式:`matches.finalAnalysisId` + `predictions` 落库 | 🟡 **未独立成记录**:锁定时刻、锁定时市场快照、锁定原因散落 |
| Settlement | `outcomes` 表 + `settleDueMatches` | ✅ |
| TrackRecord | 实时聚合计算(`services/stats.ts`),无物化表 | 🟡 每次查询重算;赛果口径变更无法追溯历史结算版本 |

**核心结论:对象链 7 个节点中,5 个已是一等公民,2 个(ModelRun、LockRecord)是"隐式存在"需要显性化,1 个(Snapshot)需补原始 payload。这是本次重构的主轴,而非推倒。**

**原则 5(AI 不参与计算)——✅ 已满足且有强保障。** 引擎纯函数零 LLM;AI 仅 `llm/reportWriter.ts` 写定性段落,且有**数字白名单**(`numberGuard.ts`:输出中任何未在事实清单/引擎输出出现过的数字 → 拒绝重写,3 次失败降级纯模板)。AI 检索的赛果/盘口经 zod + 区间校验 + 双重确认。**这是当前项目最稳的部分,保留并固化为不可回退的契约。**

**原则 6(全链路可追溯)——🔴 最大差距。** 逐项:
- 原始 API payload:🔴 **未保存**。`fetch_cache` 只存 URL+内容哈希用于去重,不存正文。适配器归一后原始响应即丢弃 → 无法事后复盘"当时供应商到底返回了什么"。
- 标准化数据:✅ `dataSnapshots.payload`(zod 归一后)。
- 快照:✅ append-only,只插不改不删。
- 模型输入输出:🟡 输出存了(`engineOutput`),**输入 bundle 未存**(只存了 `inputSnapshotIds` 引用)→ 历史快照若被新采集覆盖,无法精确重放当时输入。
- 研报版本:✅ `analyses` + 哈希链。
- 开赛锁定记录:🟡 隐式(见原则 4)。
- 赛后结算:✅ `outcomes` + `predictions.result`。

**原则 7(模型确定性)——✅ 已满足。** 引擎是纯函数,`tests/engine/*` 有黄金值+性质测试守护;`stableEngineHash` 剔除时间戳判定"是否真变化"。⚠️ 唯一隐患:`ENGINE_MODEL_VERSION` 已记录(engine-1.1.0),但**参数快照未随 ModelRun 持久化**——改了 `bookWeights` 后无法重放旧版本的确切参数。补 ModelRun 对象即解决。

**原则 8(沿用技术栈)——✅ 满足,无重写理由。** 现有栈完全胜任;唯一需要架构级决策的是 SQLite 的扩展上限(见风险点),但在当前单机+读多写少负载下不构成重写理由。

---

## 三、推荐保留 / 废弃

### 强保留(资产,勿动)
- **整个 `src/server/engine/*`**(纯函数引擎):这是平台的知识产权核心,有文献依据、有测试守护、确定性可复现。
- **`src/server/datasources/*` + `registry.ts` + `sourceHealth.ts`**:15 源中台 + 因子化 + 健康自停用,正是原则 2 要的"数据中台"。
- **哈希链与 /verify**(`publish.ts`):原则 6 信任机制的基石。
- **积分原子操作**(`unlock.ts`、`points.ts`):事务正确,有并发测试。
- **数字白名单**(`numberGuard.ts`):原则 5 的执行者。
- **测试体系**:104 单测 + 2 端到端脚本,重构的安全网。

### 重构(保留数据,改造结构)
- `dataSnapshots`:**新增 `rawPayloadId` 关联原始响应表**(补原则 6)。
- `analyses`:拆出独立的 `model_runs`(输入指纹+参数快照+耗时)与 `report_versions` 仍由 analyses 承载,二者 1:1。
- 锁定:`matches.finalAnalysisId` 升级为独立 `lock_records` 表。

### 废弃 / 收敛(技术债)
- **历史 token 名 `gold`/`gold-bright`**:已重定义为主题蓝但名字误导,渐进重命名为 `accent`(纯改名,不改值)。
- **`analyses` 表语义过载**:它同时是 ModelRun + ReportVersion + 哈希链节点,职责拆分(见下)。
- **`ratingStars` 函数名**:已返回字母评级却仍叫 stars,改名 `ratingGrade`。
- 无"必须整体删除"的模块——这印证了不需要推倒重来。

---

## 四、新架构设计:领域对象链显性化

把你定义的 7 节点对象链落成一等公民。**核心改动 = 3 张新表 + 1 张原始数据表,不破坏现有数据。**

```
Match (matches, 已有)
  └─ Snapshot (data_snapshots, 已有) ──→ RawPayload (raw_payloads, 新) 原始响应留档
        └─ ModelRun (model_runs, 新) 一次引擎执行:输入指纹+参数快照+seed+model_version+耗时
              └─ ReportVersion (analyses, 已有→瘦身) 文字研报+哈希链,关联 model_run_id
                    └─ LockRecord (lock_records, 新) 开赛锁定:终版+锁定时市场快照+时刻
                          └─ Settlement (outcomes, 已有) 赛果+结算
                                └─ TrackRecord (track_records, 新物化 或 保持聚合) 战绩归档
```

### 数据库重构方案(增量迁移,零数据丢失)

新增表(drizzle 迁移 0002):
1. **`raw_payloads`**:`id, source, url, fetchedAt, payload(原始正文), contentHash`。适配器抓取成功即落一条,`data_snapshots.rawPayloadId` 外键引用。原始数据可追溯(原则 6)。
   - 成本控制:设保留窗口(如赛后 30 天清理原始 payload,标准化快照永久留存)。
2. **`model_runs`**:`id, matchId, modelVersion, paramsHash, paramsSnapshot(JSON), inputDigest(快照id集合的哈希), engineOutput(JSON,从 analyses 迁移), trace, computedAt, durationMs`。一次引擎执行 = 一条。`analyses` 通过 `modelRunId` 引用,引擎输出不再直接挂 analyses。
3. **`lock_records`**:`id, matchId, analysisId(终版), lockedAt, closingOddsSnapshot(JSON 多书商收盘价), reason`。开赛锁定显性化,CLV 计算口径固定。
4. **`track_records`**(可选物化):结算时写入逐观点结算结果快照,带 `settlementVersion`——赛果口径若调整,旧结算记录不被覆盖。

`analyses` 瘦身:保留 version/status/contentHash/prevHash/llmSections/reportMd,`engineOutput` 迁往 `model_runs`(迁移脚本一次性搬运,旧行回填 model_run)。

### API 重构方案

现有 31 个路由保留语义,按对象链收口命名(渐进,不破坏前端):
- 读侧聚合:`GET /api/matches/[id]` 返回 Match + 当前 ReportVersion + LockRecord + Settlement(用户态按解锁权限裁剪)。
- 审计侧(新,体现"公开审计系统"定位):`GET /api/audit/[matchId]` 公开返回该场完整对象链——所有快照时间线、所有版本、锁定记录、结算、哈希验证。**这是"赛后公开审计系统"的门面 API,当前缺失。**
- 后台保持 `/api/admin/*`,新增 `/api/admin/matches/[id]/runs`(查看 ModelRun 历史)、`/api/admin/matches/[id]/lock`(查看锁定记录)。

### 前端页面重构方案(收口为四类页面)

1. **赛事列表(首页)**:今晚值得看的比赛,按评级/开球排序。已有,微调信息层级——突出"方向+评级+风险"三要素。
2. **观点页(比赛详情)**:锁定/解锁/公开三态已有。重构重点:**赛后态增加"审计视图"入口**——把对象链(快照时间线、版本演化、锁定时刻、结算比对、哈希验证)做成一个公开可查的时间线组件,这是信任的可视化。
3. **战绩页**:已有逐观点流水 + 校准。重构:接入 `track_records` 物化数据,口径版本化展示。
4. **后台驾驶舱**:已有。新增 ModelRun/LockRecord 查看,体现可追溯。

不新增:社区、专家、投稿、直播、资料库(守原则 1)。

### 后台任务重构方案

保留 4 个 cron 的职责,加固确定性与可追溯:
- 采集任务:抓取时**先落 `raw_payloads`,再归一落 `data_snapshots`**(补原则 6)。
- 建模任务:每次 `analyzeMatch` 产出一条 `model_runs`(显性化 ModelRun)。
- 锁定任务:开赛时写 `lock_records`(显性化 LockRecord)。
- ⚠️ 加分布式锁(见风险点):cron 任务用 SQLite 行锁或 `settings` 表的 advisory lock,防多实例重复执行——即使当前单实例,也为水平扩展留路。

---

## 五、分阶段开发计划与验收标准

> 原则:每阶段独立可上线、可回滚;测试先行;不破坏现有 104 测试。

### 阶段 0:本文档 + 契约固化(当前)
- 产出:REBUILD_PLAN.md(本文件)。
- 把"AI 不碰计算""供应商预测只进因子层"写成类型层约束(如 `analyses` 禁止直接写概率的 lint/类型守卫)。
- **验收**:文档评审通过;`npm test` 全绿基线(当前 104)。

### 阶段 1:可追溯性补全(原则 6,最高优先级)
- 新增 `raw_payloads` 表 + 适配器落原始响应;`data_snapshots.rawPayloadId`。
- 新增 `model_runs` 表;`analyzeMatch` 持久化输入指纹+参数快照;`engineOutput` 迁移。
- **验收**:任取一场已结算比赛,能从 DB 完整重放"当时的原始响应 → 标准化快照 → 引擎输入 → 引擎输出";`npm run demo:wc` 通过;迁移脚本对旧数据回填无损(旧 analyses 全部生成对应 model_run)。

### 阶段 2:锁定与结算对象化(原则 4)
- 新增 `lock_records`(锁定时刻+收盘价快照);`track_records` 物化结算。
- **验收**:开赛锁定产生一条不可变 lock_record;CLV 从 lock_record 的收盘价计算;赛果口径变更不污染历史结算。

### 阶段 3:公开审计视图(产品定位"赛后公开审计系统"的门面)
- `GET /api/audit/[matchId]` 公开对象链;前端赛后态"审计时间线"组件。
- **验收**:任意访客(无需登录)可查任一已结算比赛的完整证据链与哈希验证结果。

### 阶段 4:体验收口 + 技术债
- token 改名(gold→accent)、ratingStars→ratingGrade、analyses 瘦身收尾。
- 首页信息层级、战绩页口径版本化展示。
- **验收**:无 `gold` 命名残留;Lighthouse/可读性自查;全量回归。

### 阶段 5:加固(为规模化留路,非当前必需)
- cron 分布式锁;raw_payloads 保留窗口清理任务;关键服务补集成测试。
- **验收**:多实例启动不重复执行任务;原始数据按窗口自动清理且标准化快照不受影响。

---

## 六、风险点

1. **SQLite 写并发与水平扩展上限(最高)**:better-sqlite3 同步驱动 + 单写者。当前读多写少、单实例 OK;但若未来多实例或写入激增(原始 payload 落库会显著增加写量),需评估迁移 Postgres。**缓解**:阶段 1 给 raw_payloads 设保留窗口控制写量;架构上让 ORM(Drizzle)保持可切换 Postgres 的抽象。
2. **进程内 cron 无分布式锁**:多实例部署会重复采集/结算。当前单实例无害,水平扩展前必须解决(阶段 5)。
3. **原始 payload 存储膨胀**:15 源 × 多时间点 × 多比赛 → 原始正文增长快。**缓解**:保留窗口 + 仅对"成功归一"的响应留档 + 内容哈希去重。
4. **第三方源稳定性**:已有健康账本自动停用缓解;但 ESPN/竞彩等隐藏 API 可能随时变结构。**缓解**:防御式解析(已有)+ raw_payloads 留档便于事后修解析器。
5. **赛果口径变更的历史一致性**:亚盘拆腿、走水规则若调整,会影响历史战绩。**缓解**:阶段 2 的 track_records 带 settlementVersion,口径变更不覆盖历史。
6. **重构期间不破坏线上**:每阶段增量迁移 + 旧数据回填 + 可回滚;前端 API 语义保持向后兼容。

---

## 七、给决策者的一句话总结

**这不是一次重写,是一次"领域模型显性化 + 审计链补全"。** 现有项目已经把最难的部分(确定性引擎、数据中台、哈希链信任机制、积分原子性、AI 数字白名单)做对了;真正欠缺的是把"模型运行""开赛锁定"从隐式状态升级为一等对象,以及补上"原始数据留档 + 公开审计视图"这两块让平台名副其实成为"可审计系统"的拼图。按阶段 1→3 推进,4 周内即可让 PlayTop 完整兑现"赛前观点 + 赛后公开审计"的产品承诺,且全程不停机、不丢数据。
