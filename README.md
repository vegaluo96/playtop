# PlayTop（play.top）—— 足球赛事量化研究平台

机构级足球比赛预测的移动端 Web 产品：**确定性数学引擎**做预测、AI 只负责措辞、投行研报风格呈现；
赛前积分解锁、赛后全网免费公开；全部预测**开赛锁定 + 哈希链存证**，战绩页公开可验、无法事后美化。

## 产品机制

- **实时研报**：发布后调度器每 30 分钟重新采集数据 → 引擎重算 → 自动发布新版本（盘口异动/伤停/天气都会驱动改版）。用户截图分享会很快过时——这是定价的护城河。
- **积分模式**：无自助充值，积分仅由管理员后台人工添加（线下收款）；解锁按"场"计，覆盖该场全部赛前改版；延期/腰斩自动全额退款。
- **诚信机制**：每个发布版本进入全局 SHA-256 哈希链（`prevHash` 链接）；开赛瞬间锁定终版并落 `predictions`（含锁定赔率与收盘赔率）；赛后自动比对赛果判定命中。战绩口径：观望不计分母、亚盘赢半计中/输半计负、ROI 按真实拆腿逐注计算、CLV 公示。

## 预测引擎（全部有学术文献依据，零 LLM 参与计算）

| 模块 | 方法 | 文献 |
|---|---|---|
| 比分分布 | Dixon-Coles 双泊松 + 时间衰减 MLE（矩估计/市场反推/纯市场四级退化链；逐场中立场建模） | Dixon & Coles 1997, JRSS-C |
| 射门质量 | OLS 标定伪进球 + quasi-Poisson 重拟合（θ 混合） | Wheatcroft 2020, IJF |
| 实力评分 | 进球差调整 Elo + 有序 logit 三向概率 | Hvattum & Arntzen 2010, IJF |
| 盘口去水 | Shin 法（1X2）/ power 法（两向盘） | Shin 1993, EJ；Štrumbelj 2014, IJF |
| 集成 | 对数意见池（缺席模型权重自动重摊） | Genest & Zidek 1986 |
| 仓位 | 期望值扫描 + ¼ Kelly（上限 5%） | Kelly 1956, BSTJ |

引擎为纯函数（无 IO/时钟/随机），同输入必同输出，trace 全程留痕渲染进报告"计算过程"。

## 数据源（除 apiyi 的 LLM key 外，全部免 API key）

- **football-data.co.uk**：俱乐部联赛历史（含收盘赔率、射门统计）+ `fixtures.csv` 未来赛程与即时赔率（反复抓取构成盘口异动序列）
- **martj42/international_results**：1872 至今全部国家队赛果（世界杯模型底座）
- **open-meteo**：场馆地理编码 + 开球时段天气
- **本地历史库**：历史交锋/近期状态/赛季数据/积分榜确定性计算
- **AI 检索（apiyi）**：伤停/停赛/预计阵容/教练/舆情等软维度（结构化 JSON 入快照，管理员可改；AI 检索赛果一律 provisional，须管理员确认才结算）
- **手动录入**：所有维度的兜底通道（同一归一化 zod 校验）

## 快速开始

```bash
npm install
npm run db:migrate && npm run seed          # 建库 + 管理员（admin/admin123456，可用 ADMIN_USERNAME/ADMIN_PASSWORD 覆盖）
npm run import-history                      # 导入俱乐部 3 季 + 国际赛 2018 起 + Elo 回放（首次必跑，约几分钟）
npm run dev                                 # http://localhost:3000（前台） /admin（后台）
```

验证：`npm test`（51 项引擎/服务单测）· `npm run simulate`（端到端全生命周期）· `npm run typecheck` · `npm run build`

## 世界杯首测 Runbook（5 分钟）

1. 后台 → 设置：填 apiyi Key（建议选带联网检索的模型）→「测试连接」；点「导入国际赛历史」+「Elo 全量回放」（首次一次即可）。
2. 后台 → 比赛管理 →「导入世界杯 2026（自动）」：一键导入全部小组赛（openfootball 免 key 数据源；
   队名自动映射 martj42 口径、中立场/场馆/时区自动处理）；淘汰赛对阵确定后由调度器每 6 小时自动补建。
3. 工作台按"下一步"引导操作：录入盘口（世界杯无免费盘口源，从任意盘口网站抄 1X2/大小/亚盘）→
   采集（48h 内场次也会被调度器自动采集）→ 运行引擎 → 审阅定价 → 发布。
4. 发布后自动进入实时改版；开赛自动锁定终版；赛后录入比分（或等 AI 检索 provisional 后确认）即自动结算、全网公开、战绩更新。
5. 前台手机访问：注册用户 → 后台给该用户充积分 → 解锁查看 → 赛后验证报告哈希。
6. 联赛赛季中无需手动建赛：调度器每 6 小时自动同步 fixtures.csv（自动建赛 + 盘口异动序列）。

## 部署（play.top）

```bash
docker build -t playtop .
docker run -d --name playtop -p 3000:3000 \
  -v playtop-data:/app/data \
  -e SESSION_SECRET=请改成随机长串 -e COOKIE_SECURE=1 \
  -e ADMIN_USERNAME=youradmin -e ADMIN_PASSWORD=强密码 \
  playtop
# 前置 nginx/caddy 做 https（play.top）反代 :3000
```

迁移与管理员自举在启动时自动执行；历史导入可在后台设置页一键触发。非 Docker 部署：`npm run build && node .next/standalone/server.js`（同样挂 `data/` 持久目录、带上 `drizzle/`）。

## 工程结构

```
src/server/engine/       纯函数预测引擎（DC/Elo/devig/集成/市场/Kelly）
src/server/datasources/  免 key 数据适配器 + 归一化 zod schema
src/server/services/     采集/建模/发布(哈希链)/解锁(原子积分)/结算/战绩
src/server/jobs/         进程内调度：状态机 10m · 实时改版 30m · 赛果 6h
src/app/(user)/          移动端：首页/研报三态/战绩/我的
src/app/admin/           桌面后台：看板/比赛工作台/用户积分/设置
scripts/                 seed · import-history · backfill-elo · simulate-match
tests/                   引擎黄金值/性质测试 + 服务层事务/防篡改测试
```

---
本平台输出为量化研究内容，仅供参考，不构成任何投注建议。
