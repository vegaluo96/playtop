# 足球终端(play.top)交接文档

> 写给接手本仓库的开发者/AI(代码审查 + 继续开发)。最后更新:2026-06-12。
> 当前状态:`main` 可部署,116 项单测全绿,tsc/build 零错误,selfcheck L0-L4 通过(环境项除外)。

---

## 1. 项目定位与不可违背的红线

**定位**:足球盘口数据资讯终端(对标交易所级体验,参考 Robinhood/OKX/足球财富)。
**红线(历史决策,改动前必须与产品负责人确认)**:

1. **平台只提供数据资讯与分析,不提供任何形式的投注/博彩服务**——全站页脚、/about、注册条款都有此声明,新页面也必须带。
2. **绝不伪造数据**:
   - 没有真实盘口变化时不允许跳数字(Flash 组件只渲染真实变化);
   - AF 没有的数据端点不得编造(如裁判统计);天气拿不到就整卡隐藏;
   - 角球/射正等合成事件只来自官方统计差分,首帧只记基线不补发历史;
   - 样本不足时如实展示"归档积累中/样本 N 场",绝不填充假样本。
3. **密钥安全**:仓库是公开的。管理员账号只走 env(`ADMIN_EMAIL`/`ADMIN_PASSWORD`),AF/LLM 密钥走后台系统设置(kv,打码显示,有审计)或 env,**任何密钥不得出现在代码/提交里**。
4. **书商打码**:用户端书商名必须经 `maskBookmaker`(Bet365→Be***5);后台不打码。
5. **数据源唯一**:比赛数据只用 API-Football v3;LLM 走 API易;天气 MET Norway(免费官方,CC-BY 注明来源)。

---

## 2. 运行与部署

```bash
npm run dev            # 开发(web)
npm run worker         # 数据抓取进程(独立,必须与 web 同时跑)
npx vitest run         # 单测(当前 116 项)
npm run build          # 生产构建(含 eslint;tsc 另跑 npx tsc --noEmit 才覆盖 scripts/)
npm run selfcheck      # 平台闭环体检 L0-L5(子命令见 §8)
```

- **DB**:SQLite(node:sqlite,Node ≥22.5),路径 env `PLAYTOP_DB`(默认项目内)。WAL + busy_timeout 8000;web 与 worker 双进程共写,写路径必须走 `tx()`。
- **生产**:阿里云 47.82.67.99,项目在 `/home/admin/playtop`,pm2 跑 `playtop-web` + `playtop-worker`(admin 用户),env 在 `/srv/playtop.env`(selfcheck CLI 会自动加载)。
- **部署**:`cd ~/playtop && bash scripts/deploy.sh`。脚本会 `git pull --ff-only`;仅在 `package.json` / `package-lock.json` 变化或 `node_modules` 缺失时跑 `npm ci`,平时直接 build + 重启 pm2。
- 表结构在 `src/server/db.ts` 一处定义,启动时 `CREATE TABLE IF NOT EXISTS` 自动建,无独立迁移系统(加列需写兼容迁移,见 movements.phase 先例)。

---

## 3. 架构总览

```
API-Football v3 ──┐
MET Norway 天气 ──┤   scripts/worker.ts(独立进程,双速循环:整轮 60s + 滚球快循环可至 5s)
API易 LLM     ──┘        │ 按「距开赛时间」8 档分层抓取(schedule.ts TIERS,后台可调)
                          ▼
                 SQLite(快照/异动/事件/译名/账务全在自有库)
                          ▲ 只读为主
        Next.js 15 App Router(src/app:页面 + API 路由)
                          ▼
   移动壳(<1080px,4 Tab)/ 桌面三栏终端(≥1080px)/ 管理后台(/admin,9 模块)
```

**关键数据流**:
- 赛前盘口:worker 按档位拉 `/odds` 全分页 → `archiveOdds`(odds_raw 原始包 + odds_snapshots 归一化 + diff 出 movements)。AF 赛前盘只有开赛前 14 天窗口,所以**走势/初盘全部出自自有归档**,「初盘」=本站归档首帧(界面如实标注,不冒充真实初盘)。
- 滚球:`/odds/live` → kv 实时盘卡 + `archiveLiveOdds`(变化帧落 live_odds_snapshots + 滚球异动);比分 bundle(events/statistics/lineups/players)随 `fixtures?ids=` 批量回写 payload。
- 合成事件:`events-synth.ts` 对滚球统计做累计值差分 → 带序号的角球/射正/射偏/越位事件 + 开赛/中场/完场节点(kv `fx:{id}:synthev`)。
- 视图:`src/server/views/*` 把库数据组装成中文化视图模型,API 路由薄壳。

---

## 4. 代码地图(按职责)

### 服务端核心 `src/server/`
| 文件 | 职责 |
|---|---|
| `db.ts` | 全部建表 + `db()`/`tx()`;`_resetDbForTest` 供单测 |
| `af/client.ts` | AF HTTP(密钥 kv 优先 env 兜底、2s 同 URL 防抖、10min TTL 缓存,`force` 绕过) |
| `af/schedule.ts` | 8 档抓取阶梯 TIERS、isLive/isFinished、freshLine(档位→用户文案) |
| `af/normalize.ts` | **盘口归一化核心**:`pickMainPair`(亚盘两种腿标签格式数学自证配对、满水率选主盘)、`normalizeLiveOddsItem`。改这里必须跑 normalize/live-store 测试 |
| `af/store.ts` | fixtures/odds/predictions 落库与查询;`oddsSeries` 选源规则(最新鲜书商,PRIMARY 优先);kv |
| `af/live-store.ts` | 滚球帧归档(仅变化帧+5min 心跳、封盘跳过、60s 冷却防刷屏)、prune |
| `af/events-synth.ts` | 统计差分合成事件(见 §3) |
| `af/markets.ts` | odds_raw 读时解析 10 种扩展玩法(零额外抓取) |
| `af/panorama.ts` | 详情页数据全景拉取(bundle/odds/prediction/injuries/deep) |
| `views/detail.ts` | 详情页视图模型(走势/百家+凯利/时间轴/积分榜/阵容/深挖/天气/insights) |
| `views/composite.ts` | **综合指数**:共识盘=各书商主盘中位数,指数=共识盘下净水中位数(≥3 家,不足回退);方法字符串随 payload 下发 |
| `views/insights.ts` | 赌球洞察:盘路(临场盘×比分)、凯利/离散、同赔历史、疲劳、角球参考;kv 缓存 10min |
| `views/history.ts` | 历史报价逐帧回查(支持按 bookmaker_id 过滤) |
| `views/names.ts` + `lib/names-zh-dict.ts` | 译名链:词典 → name_zh 表 → 原名+入队(worker 每 10min LLM 批量音译入库) |
| `platform/weather.ts` | MET Norway + Open-Meteo 地理编码;成功/失败双 TTL 负缓存;拿不到→null |
| `platform/rate-limit.ts` | 内存令牌桶 + 登录锁定(5 次/15min→423) |
| `llm/report.ts` | AI 报告:指纹变化才出新版、开赛锁定、版本历史(report_versions) |
| `selfcheck.ts` | 体检实现 + 盘口审计(audit/verify/renorm) |

### 前端 `src/app` + `src/components`
- 移动 4 Tab:`/`(列表)`/moves` `/predictions` `/me`;详情 `/match/[id]`(一级 4 组:盘口[走势/百家/盘路/更多玩法]/赛况/人员/深度),报告 `/report/[id]`。
- 桌面:`components/desktop/terminal.tsx`(三栏壳)+ `center.tsx`(中栏,与移动同数据契约)。
- 共用组件:`live.tsx`(Flash 真实跳动/HeartBeat 连接状态/useUnifiedPoll 四菜单统一轮询)、`match-timeline.tsx`(直播时间轴+天气卡)、`insights.tsx`、`quote-history.tsx`、`watch.tsx`(自选关注)、`page-header.tsx`、`refresh-sheet.tsx`。
- **视口约定**:html/body 锁 100%+overflow hidden,滚动只在内部容器(修过移动端整页滚动 bug,别回退)。

### 管理后台 `/admin`(9 模块)
运营看板/用户/订单积分/赛事内容/营销/风控审计/工单/数据与模型监控/系统设置。RBAC 简单角色;所有敏感操作写 audit_log。

---

## 5. 数据库表速查

业务:`users sessions ledger unlocks redeem_codes redemptions invites tickets watchlist`
行情:`fixtures_cache odds_raw odds_snapshots live_odds_snapshots movements predictions_snapshots model_records name_zh kv`
运营:`free_fixtures hidden_fixtures announcements admins audit_log risk_queue metrics_daily endpoint_metrics report_versions`

口径要点:
- `odds_snapshots.line` 正=主让(与 ahText 一致);**ah/ou 的 h/a 存净水,eu 存欧赔小数**(算返还率时 ah/ou 要 +1)。
- `movements.phase`:盘前|滚球。
- kv 惯例:`fx:{id}:liveodds / stats_half / synthev`、`geo:* wx:*`(天气)、`insights:{id}`、`cidx:*`(综合指数缓存)。

---

## 6. API 端点(用户端)

`GET /api/health`(workerAt/liveNow/intervals)· `/api/config` · `/api/matches?day=live|soon|today|tmr|d2..d13`(soon=默认即将视图)· `/api/match/[id]?deep=1` · `/api/match/[id]/history?mk=&bk=` · `/api/moves?type=` · `/api/predictions` · `/api/report/[id]?v=` · `/api/player/[id]` · `/api/watch`(GET/POST)· `/api/wallet /api/unlock /api/track /api/login...`
免注册边界:非直播行前 3 条完整其余打码(服务端执行,`guestMasked`)。

---

## 7. 容易踩坑的口径(审查重点)

1. **亚盘配对**(normalize.ts):AF 两种腿标签格式(镜像/同号),用满水率打分自证 + 1X2 方向裁决;主盘=最平衡线。历史上的"大小球取错边缘线"bug 就出在这里,回归测试已锁。
2. **净水 vs 小数**:见 §5;payoutRate 调用处已转换,新代码注意。
3. **时区**:对用户展示一律走 `prefs.tz`(`parseTzOffset`);insights 盘路日期目前服务端写死 UTC+8(已知小债,见 §9)。
4. **oddsSeries 选源**:取"最新一帧最新鲜"的书商,不强制全场同源;百家对比可查任一家。审计文案与此口径一致。
5. **worker 配额**:相邻出网调用 ≥AF_DELAY_MS(300ms),紧急降频(配额>85% 自动×2);新增端点调用必须走 `paced()+tracked()`。
6. **i18n**:`t(key)` 体系只覆盖部分界面;数据名走 nameZh 链,与 i18n 是两套(别合并)。
7. **测试**:跑 `npx tsc --noEmit`(next build 不查 scripts/)+ vitest;改归一化/盘路/合成事件必须补回归测试,惯例见 tests/。

---

## 8. 自检工具(交付验证用)

```bash
npm run selfcheck                      # L0-L5 闭环(env 带 ADMIN_* 跑 L5)
npm run selfcheck -- --llm             # 含 LLM(耗少量 token)
npm run selfcheck -- audit <fid>       # 单场盘口四层保真审计(AF原始→归一化→落库→显示)
npm run selfcheck -- audit upcoming 3  # 最近 3 场即将开赛自动审计
npm run selfcheck -- verify            # 未来 48h 全部场次主盘 vs AF 源,✓/△/✗ 自动判定
npm run selfcheck -- renorm [fid|all]  # 归一化修正后重放 odds_raw 重建快照
```
沙箱 UI 走查惯例:种子库 + standalone 启动(需 `cp -r .next/static .next/standalone/.next/`)+ playwright-core 截图(repo 内已装 playwright-core + @sparticuz/chromium)。

---

## 9. 已知技术债 / 待办(如实)

1. **英文语言包**:界面层全量 key 化只完成部分(~原 33 号需求),剩余约数百处中文字面量未 key 化(管理后台有意不做)。
2. **insights 盘路日期**:服务端格式化写死 UTC+8(insightsView 结果是全局 kv 缓存,做不了 per-tz;要么缓存键带 tz,要么下发时间戳由前端格式化)。
3. **CSP**:仍是 Report-Only(全站内联样式,直接强制会白屏);收紧需先做样式整改。
4. **盘路/同赔覆盖**:依赖自有归档,上线初期样本薄(界面已如实标注),随时间自然变厚,无需处理。
5. **桌面 1080-1240 区间**:布局可用但偏挤,未做专门优化。
6. **player API**:AF 球员接口偶发慢,已做并行+缓存+骨架,但首次点开冷缓存仍 1-2s。

---

## 10. 近期交付时间线(便于读懂 git log)

- 大小球主盘选择修复(pickMainPair 重写)→ `323dedd`
- AF 数据全量补齐(10 玩法/17 统计/完整积分榜/赛季面板)→ `a8b5842`
- 信息架构重组(4 组一级导航)→ `b1ca8af`
- 比赛直播页(双列时间轴/文字直播/统计差分合成事件/MET 天气)→ `3cca957`
- 赌球洞察六件套(盘路/凯利离散/同赔/升降盘/疲劳/角球参考)→ `d68bd49`
- 历史报价回查 + 页头统一 + 刷新规则阶梯弹层 → `6067eb9`
- 四菜单统一轮询(liveNow 驱动 3s/10s)+ 百家单家历史 → `f02551b`
- 连接状态行(已连接·实测延迟)→ `3fe8f83`
- 自选关注/滚球行增强/详情细节/桌面滚球雷达 → `e0b2191`
- 视口滚动修复/详情头重设计/队名队标镜像/首页「即将」默认视图 → `ba50ab7`

---

## 11. 给代码审查者的建议切入点

1. `src/server/af/normalize.ts`(盘口正确性的命脉,测试在 tests/af/normalize.test.ts + live-store.test.ts)
2. `src/server/views/composite.ts` + `insights.ts`(对用户可见的计算值,方法论随 payload 披露,改算法必须同步改 method 字符串)
3. `scripts/worker.ts`(配额阶梯/双速循环/幂等性;任何新增出网调用过 paced+tracked)
4. 安全面:`platform/rate-limit.ts`、同源断言、next.config headers、guest 打码边界(tests/platform/rules.test.ts)
5. 商业闭环:钱包/解锁/邀请/兑换(selfcheck L4 全自动验证,改动后必跑)
