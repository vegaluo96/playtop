# MiCall.ai

让用户**感觉在和一个真实的人通话**的移动端（H5）AI 语音陪伴产品。

> 开发的最高纲领是 [`docs/CLAUDE.md`](docs/CLAUDE.md)（项目宪法）。任何开发决策以它和三份规格文档为准。

## 仓库结构

```
docs/                         项目宪法 + 三轨规格（开发唯一依据）
  CLAUDE.md                   ← 最先读：两条第一性原理、四层防线、三轨结构、节点选型、全局铁律
  01-角色资产生成规范.md        资产轨
  02-后端架构与实现规格.md      后端轨
  03-前端对接规格.md            前端轨
prototype/                    DC 原型（视觉/交互/文案的唯一真相，已冻结）
  AI Call.dc.html             用户端 UI 原型
  MiCall Admin.dc.html        后台管理端原型
  support.js                  DC 运行时
frontend/                     ✅ 用户端 H5 生产前端（前端复刻轨）—— 见 frontend/README.md
admin/                        ✅ 运营管理端（11 tab）—— 见 admin/README.md
asset-pipeline/               ✅ 资产管线轨（角色 spec/校验/导入导出）—— 见 asset-pipeline/README.md
```

## 三轨进度

项目按宪法分三条边界清晰的轨道交付：

| 轨道 | 说明 | 状态 |
|---|---|---|
| **前端复刻轨**（确定性） | `AI Call.dc.html` → 生产 React，mock 换服务端信令 | ✅ 已落地（`frontend/`） |
| 资产管线轨 | 角色 spec、生成工作流、导入导出校验 | ✅ 已落地（`asset-pipeline/`） |
| 后端四层防线轨 | 实时管线 / 单轮质量 / 记忆人格 / 自主演进 | ⬜ 待开发（第一步：尺度一延迟 spike） |
| Admin 后台（11 tab） | `MiCall Admin.dc.html` → 运营管理端 | ✅ 已落地（`admin/`） |

> 选择**前端复刻轨**先行的理由：宪法明确把它标为「确定性」——原型即唯一真相，无设计裁决、
> 无外部服务不确定性（无需 API key、无实时延迟风险），且可对照原型客观验收，是最不容易出错的起点。

## 前端：已完成内容

把 DC 原型**逐像素逐文案**复刻为生产级 Vite + React + TypeScript 应用，并按
`docs/03-前端对接规格.md` 把通话流程的 mock 换成服务端控制信令（删除 18% 假失败、
前端计时改服务端权威计费、删除假台词、`grantMic` 改真实 `getUserMedia`）。

实现细节、设计取舍与运行方式见 [`frontend/README.md`](frontend/README.md)。

```bash
cd frontend && npm install
npm run dev      # 走内置 mock 信令，无需后端即可独立运行
npm run build    # 类型检查 + 生产构建
npm run smoke    # 无浏览器渲染冒烟测试（jsdom）
```
