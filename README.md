# PlayTop（play.top）

平台重建中——旧实现已清空，准备从头重新设计与制作。

当前仓库仅保留一个最小可部署的 Next.js 15（App Router）骨架，
用于在不改动共享服务器/部署链路的前提下，先让线上呈现「重建中」占位页。

## 已有地基：API-Football 数据层

新平台 100% 基于 API-Football v3 做数据（src/server/af/）：

- `client.ts` — v3 客户端：env `API_FOOTBALL_KEY`、统一响应信封、TTL 缓存与配额保护、分页聚合
- `catalog.ts` — 官方文档全部 39 个数据端点的目录（参数白名单 + 必填校验）+ 通用调用器

CLI 查数/排障（无需 UI）：

```bash
npm run af                                   # 列出全部端点
npm run af -- status                         # 验证 key 与配额
npm run af -- fixtures date=2026-06-11 league=39
npm run af -- selftest                       # 真机自检：39 端点各打一枪 + 净消耗配额
npm run af -- selftest season=2023 delay=7000   # 限流套餐调大 delay（毫秒）
```

`selftest` 会先解析一个真实上下文（联赛→赛季→一场已结束比赛→主客队→球员→教练），
再把真 ID 喂给依赖型端点，逐一汇总「✓回数据 / ·空 / ✗报错 / —跳过」并算出本次净消耗
的请求数——一份可复现的"数据确实接通"证据。

产品层（页面/聚合/引擎）等新设计定稿后再叠加在这层之上。

## 开发

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 产出 .next/standalone（Docker 部署用）
npm run test
npm run typecheck
```

## 部署

沿用既有单容器契约（见 `Dockerfile`，`output: "standalone"`）：构建后由
`server.js` 在容器内监听 3000；服务器侧的反代与 `deploy.sh` 不在本仓库内、保持不变。

## 旧版本

清空前的完整实现保存在分支 `claude/relaxed-cori-ymv35p`
（提交 `4054f89`）与本地标签 `backup/pre-rebuild-2026-06-11`，可随时找回。
