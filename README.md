# ZSKY.COM 足球天空

亚盘 · 大小球 · 胜平负 —— 面向中国用户的足球数据分析平台(移动 390px 基准 + 桌面三栏终端)。
**仅提供体育数据资讯与分析,不提供任何形式的投注/博彩服务。**

> 接手开发先读:`AGENTS.md`(AI 开发守则)→ `docs/data-contract.md`(数据契约·唯一规范)→ `HANDOFF.md`(架构/口径/技术债交接文档)。

## 架构

```
Next.js 15 App Router(UI + API 路由)
   │  读
   ▼
SQLite(node:sqlite,Node ≥22.5,零外部依赖;env PLAYTOP_DB,WAL)
   ▲  写(tx)
worker(npm run worker,独立进程,双速循环):按「距开赛时间」8 档分层轮询 API-Football v3
  14d–48h 每12h → 48–12h 每3h → 12–6h 60min → … → 临场 1min → 滚球可至 5s(后台可调)
odds/predictions/滚球帧/事件持续归档 → 走势/异动/盘路/同赔/战绩全部出自自有库
天气:挪威气象局 MET Norway(免费官方,CC-BY 注明来源);AI 深度报告:LLM(API易),指纹变化才出新版、开赛锁定、版本历史
```

### 双端布局(共享 token / 数据契约 / 商业规则,仅视图层分叉)

- **<1080px 移动**:4 Tab + 二级页 + 底部 sheet
- **≥1080px 桌面**:三栏终端(左赛事列表 / 中 5 tab 工作区 / 右滚球雷达+异动流+本场预测);
  账户=右滑抽屉,弹层=居中弹窗;深链(/match /report /me…)按视口自动归一
- 视口约定:html/body 锁滚动,页面滚动只发生在内部容器(移动端地址栏伸缩 bug 的根治方案,勿回退)

### 页面

| 路由 | 内容 |
|---|---|
| `/` | 赛事列表:默认**「即将」**视图(滚球置顶+未来24h按开球时间排)、直播/今日/明日/更多日期弹层、联赛筛选、**自选关注置顶分组**(游客本地/登录入账户)、滚球行内半场比分·角球·红牌、异动标 |
| `/match/[id]` | 详情 4 组:**盘口**(走势·综合指数/百家对比·凯利·离散·升降盘/盘路·同赔历史/更多玩法·角球参考,含完整历史报价回查)/**赛况**(双列直播时间轴+文字直播+天气+体能赛程)/**人员**(阵容+伤停)/**深度**(深挖+AI 深度报告入口) |
| `/moves` | 异动流:全部/滚球/升降盘/水位筛选、快照对比弹层(急变标) |
| `/predictions` | 预测:战绩横幅(7 日条形+昨日复盘)、轻量预测卡、解锁流 |
| `/report/[id]` | AI 深度报告:版本切换(随盘口变化出新版,开赛锁定)、五分区正文 |
| `/me` 等 | 钱包/兑换/邀请/关注/涨跌配色/语言/外观/时区/工单/FAQ/版本 |
| `/admin` | 管理后台 9 模块:运营看板/用户/订单积分/赛事内容/营销(充值档位·兑换码·公告)/风控审计/工单/数据与模型监控(抓取档位可调)/系统设置(密钥) |

### 商业规则(src/server/platform/,服务端记账,单测锁死)

- 免注册:列表/异动前 3 条 + 直播完整,其余打码(**服务端打码**,非前端遮罩)
- 注册后完整查看盘口、异动与数据细节;新人礼包 +58 积分;唯一收费项 = 模型预测与 AI 深度报告(赛前 38 / 开赛后 58,解锁永久可见)
- 每日免费分析场(后台可多选);充值档位后台可调(首充 +50%);兑换码;邀请奖励(日/周/月上限)
- 安全:速率限制+登录锁定、同源断言、安全响应头(CSP 暂 Report-Only)、审计日志

### 数据层(src/server/af/ + views/)

- `client.ts` v3 客户端(TTL 缓存/配额保护) · `catalog.ts` 43 端点全目录 · `schedule.ts` 8 档抓取阶梯
- `normalize.ts` 赔率归一化:亚盘两种腿标签格式数学自证配对、满水率选主盘;line 正=主让;ah/ou 存净水、eu 存小数
- `store.ts`/`live-store.ts` 赛前快照 + 滚球变化帧归档,diff 出异动(盘前|滚球);`events-synth.ts` 滚球统计差分合成角球/射正等带序号事件
- `views/composite.ts` 综合指数(多书商共识中位数,方法论随 payload 披露) · `views/insights.ts` 盘路/凯利/同赔/疲劳 · `views/names.ts` 译名链(词典→库→LLM 队列)

### 设计 token(globals.css)

涨跌红绿为用户设置(红升绿降/绿升红降):所有升降/✓✗/盈亏一律走 `var(--up)`/`var(--down)`,
由 `<html data-scheme>` 切换,**严禁写死**。数字一律 IBM Plex Mono;**只渲染真实变化**(Flash/HeartBeat 见 components/live.tsx)。

## 运行

```bash
npm install                  # Node ≥ 22.5(node:sqlite)
cp .env.example .env.local   # 填 API_FOOTBALL_KEY(或后台系统设置里配)
npm run dev                  # Web(http://localhost:3000)
npm run worker               # 数据抓取(独立进程;免费套餐设 AF_DELAY_MS=7000)
npm run test && npm run typecheck   # vitest(116 项)+ tsc 全仓
```

CLI 排障与数据校验:

```bash
npm run af -- status                  # 验证 key 与配额(全部 43 端点目录:npm run af)
npm run selfcheck                     # 平台闭环体检 L0-L5
npm run selfcheck -- verify           # 未来 48h 全部场次主盘 vs AF 源,自动判定 ✓/△/✗
npm run selfcheck -- audit <fid>      # 单场盘口四层保真审计
```

## 部署

生产:pm2 双进程(`playtop-web` 跑 standalone server.js + `playtop-worker`),env 见 `/srv/playtop.env`;
推荐使用快速部署脚本:

```bash
cd ~/playtop && bash scripts/deploy.sh
```

脚本会 `git pull --ff-only`;仅当 `package.json` / `package-lock.json` 变化或 `node_modules` 缺失时才执行 `npm ci`,其余部署直接 build + 重启 pm2。
亦提供 `Dockerfile`(output: standalone)可容器化,worker 作第二进程同卷挂 `PLAYTOP_DB`。

## 已知待办(详见 HANDOFF.md §9)

- [ ] 支付网关接入(当前为演示支付)
- [ ] 英文语言包全量 key 化(界面层完成部分;管理后台有意不做)
- [ ] CSP 从 Report-Only 收紧(需先整改内联样式)
