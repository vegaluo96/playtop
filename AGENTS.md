# 给 AI 开发者的工作守则(Codex / Claude 等通用)

**先读根目录 `HANDOFF.md`**(架构、数据流、口径、技术债全在里面),AF 数据覆盖矩阵见 `docs/af-coverage.md`。本文件只放必须时刻遵守的规矩。

## 红线(违背=事故)

1. 平台只做体育数据资讯与分析,**不提供任何形式的投注/博彩服务**;新页面必须带合规页脚。
2. **绝不伪造数据**:无真实盘口变化不允许跳数字;AF 没有的数据不得编造;拿不到的数据整块隐藏并如实标注"积累中/样本 N 场"。
3. 仓库公开:**任何密钥/账号不得写进代码或提交**(管理员走 env,AF/LLM 密钥走后台 kv 或 env)。
4. 用户端书商名必须经 `maskBookmaker` 打码。

## 每次改动的验证底线

```bash
npx tsc --noEmit        # next build 不覆盖 scripts/,必须单独跑
npx vitest run          # 当前 116 项全绿,不允许带红合并
npm run build
```

- 改 `src/server/af/normalize.ts` / `views/composite.ts` / `views/insights.ts` / `af/events-synth.ts`(对用户可见数值的命脉)→ **必须补回归测试**,并跑 `npm run selfcheck -- verify` 对 AF 源校验盘口。
- 改算法必须同步更新随 payload 下发的 method 披露字符串。
- UI 改动:种子库 + standalone + playwright 截图走查(惯例见 HANDOFF §8),390px 与 ≥1080px 双端。

## 工程约定

- 写库一律走 `tx()`(web/worker 双进程共写 SQLite);worker 新增出网调用必须包 `paced()+tracked()`(配额保护)。
- 用户展示时间一律走 `prefs.tz`;ah/ou 快照存净水、eu 存欧赔小数;`line 正 = 主让`。
- 提交信息用中文,说明动机与影响面;**允许直推 main**,但有硬性门槛:
  - 推 main 前 `npx tsc --noEmit && npx vitest run && npm run build` 必须三绿,结果贴在回复里;
  - 涉及盘口数值命脉文件(normalize/composite/insights/events-synth)必须附带回归测试;
  - 禁止 force-push / 改写 main 历史;大型重构先开分支、跑通后再合;
  - main ≠ 立即上线:生产由人工在服务器 `git pull` 部署,推完 main 在回复里说清改了什么、部署后该验证什么。
- html/body 已锁滚动(移动端视口 bug 修复),滚动只允许发生在内部容器,勿回退。
