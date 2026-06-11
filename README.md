# PlayTop（play.top）

平台重建中——旧实现已清空，准备从头重新设计与制作。

当前仓库仅保留一个最小可部署的 Next.js 15（App Router）骨架，
用于在不改动共享服务器/部署链路的前提下，先让线上呈现「重建中」占位页。

## 开发

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 产出 .next/standalone（Docker 部署用）
npm run typecheck
```

## 部署

沿用既有单容器契约（见 `Dockerfile`，`output: "standalone"`）：构建后由
`server.js` 在容器内监听 3000；服务器侧的反代与 `deploy.sh` 不在本仓库内、保持不变。

## 旧版本

清空前的完整实现保存在分支 `claude/relaxed-cori-ymv35p`
（提交 `4054f89`）与本地标签 `backup/pre-rebuild-2026-06-11`，可随时找回。
