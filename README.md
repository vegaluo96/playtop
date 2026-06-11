# 足球终端（www.play.top）

亚盘 · 大小球 · 胜平负 —— 移动端盘口数据终端(390px 设计基准)。
视觉/交互唯一基准:`盯盘Pro 足球盘口终端.dc.html` 设计稿;产品骨架与商业规则见交接文档 HANDOFF.md。

## 架构

```
Next.js 15 App Router(UI + API 路由)
   │  读
   ▼
SQLite(node:sqlite,Node ≥22.5,零外部依赖;env PLAYTOP_DB)
   ▲  写
worker(npm run worker,独立进程):按「距开赛时间」分层轮询 API-Football v3,
odds/predictions 快照持续归档(AF 赛前 odds 仅 1–14 天窗口)→ 走势/异动/战绩全部出自自有库
```

### 页面(4 Tab + 二级页)

| 路由 | 内容 |
|---|---|
| `/` | 赛事列表:日期/联赛筛选(世界杯 chip 特效)、三列等宽盘口卡、异动标、刷新规则弹层 |
| `/match/[id]` | 详情 6 tab:盘口走势(滚球实时盘/封盘态)/百家对比/技术面/阵容/情报/深挖 |
| `/moves` | 异动流:升降盘/水位筛选、快照对比弹层(急变标) |
| `/predictions` | 预测:战绩横幅(7 日条形+昨日复盘弹层)、轻量预测卡 |
| `/report/[id]` | AI 分析报告:七维对比 + 五分区正文(盘口解读/状态盘路/进球模型/人员情报/结论风险) |
| `/me` `/me/ledger` `/me/tickets` | 钱包/兑换/邀请/关注/涨跌配色/语言/外观/时区/工单/退出 |
| `/login` `/i/[code]` | 邮箱登录注册(无验证)、邀请落地 |

### 商业规则(src/server/platform/,服务端记账,单测锁死)

- 免注册:列表/异动前 3 条 + 直播完整,其余打码(**服务端打码**,非前端遮罩)
- 注册即全站数据免费;新人礼包 +58 积分;唯一收费项 = 预测(赛前 38 / 开赛后 58,解锁永久可见)
- 每日 1 场平台指定免费预测;充值 ¥6/60 … ¥648/8420(首充 +50%);兑换码;邀请 +1/人(日10/周30/月100)

### 数据层(src/server/af/)

- `client.ts` v3 客户端(TTL 缓存/配额保护) · `catalog.ts` 39 端点目录 · `selftest.ts` 真机自检
- `schedule.ts` 抓取分层:>12h 巡检 → 60/30/10/5/1min → 滚球 1min;滚球与 T-30min 内 force 绕缓存
- `normalize.ts` 赔率归一化(亚盘 line 正=主让;净水=赔率-1)+ 异动判定(急变:盘口位移 ≥0.25 或水位 |Δ|≥0.05)
- `store.ts` 快照落库 + 相邻快照 diff 生成异动 + 模型战绩结算(完场对照预测自动统计)
- `panorama.ts` matchPanorama(fixtureId):/fixtures?id= 单请求 bundle + 快照库 + 低频维度一次拼装

### 设计 token(globals.css)

涨跌红绿为用户设置(红升绿降/绿升红降):所有升降/✓✗/盈亏一律走 `var(--up)`/`var(--down)`,
由 `<html data-scheme>` 切换,**严禁写死**。数字一律 IBM Plex Mono;弹层=底部 sheet;浅色模式=MVP invert 方案。

## 运行

```bash
npm install              # Node ≥ 22.5(node:sqlite)
cp .env.example .env.local   # 填 API_FOOTBALL_KEY
npm run dev              # Web(http://localhost:3000)
npm run worker           # 数据抓取(独立进程;免费套餐设 AF_DELAY_MS=7000)
npm run test && npm run typecheck
```

CLI 查数/排障:

```bash
npm run af                                   # 列出全部 39 端点
npm run af -- status                         # 验证 key 与配额
npm run af -- selftest delay=7000            # 真机自检 + 净消耗配额
```

兑换码发放(暂用 SQL,后续做后台):

```sql
INSERT INTO redeem_codes (code, points, max_uses) VALUES ('WC2026', 100, 1000);
```

## 部署

沿用既有单容器契约(`Dockerfile`,`output: "standalone"`):Web 容器跑 `server.js`;
worker 以第二进程跑 `npm run worker`(同一数据卷挂 `PLAYTOP_DB`)。反代与 `deploy.sh` 不变。

## 待办(对照 HANDOFF 开发顺序)

- [x] 1. 脚手架+路由+设计 token
- [x] 2. 账户/积分/解锁/兑换/邀请(+工单)
- [x] 3. 数据层:调度器+快照落库+matchPanorama
- [x] 4. 页面接真数据(列表→详情→异动→预测)
- [x] 5. AI 报告(规则模板版;LLM 润色挂点在 views/report.ts)
- [x] 6a. 分享海报(canvas)/战绩统计 job
- [ ] 6b. 工单后台(管理端回复)、支付网关接入(当前演示支付)、盘路统计(赢盘率/大球率,需快照积累)
- [ ] 语言包全量翻译(当前简中全量 + 6 语言占位)
