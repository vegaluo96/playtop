# MiCall.ai

让用户**感觉在和一个真实的人通话**的移动端（H5）AI 语音陪伴产品。
已上线运行于阿里云香港 —— 用户端 [`zsky.com`](https://zsky.com)、运营后台 `admin.zsky.com`。

> 开发的最高纲领是 [`docs/CLAUDE.md`](docs/CLAUDE.md)（项目宪法）。任何开发决策以它和三份规格文档为准。

## 产品形态

- **用户端 H5**：点开角色即进入**全双工语音通话** —— 可随时打断、你来我往，像真人聊天。
- **角色有"灵魂"**：四层 context —— 角色人设（出厂资产） + 关系/画像（per-user） + 情节记忆（语义召回） + 角色自主状态（独立于用户的"今天心情/近况"）。她会记得你、有自己的生活与小脾气，不是单向应答的客服。
- **运营后台**：角色管理（人设 / 说话风格 / 基础资料 / 音色全字段可编辑、可新建）、接口配置（endpoint/key 存服务端）、用户 / 订单 / 通话 / 成本看板、邀请裂变、工单。

## 技术栈 / 架构

- **实时媒体（自建，不依赖商业 RTC 厂商）**：浏览器原生 `RTCPeerConnection` + 自建 [`aiortc`](https://github.com/aiortc/aiortc)（Python）+ 自建 coturn（TURN/STUN）做全双工 RTC；硬件回声消除（AEC）只在 RTC 媒体面成立。WebSocket（TCP/443）作为兜底音频通道，RTC 真正连上前先走 WS、连上即切，启动不阻塞。
- **流式管线（首句抢跑，~1.6s 首音）**：实时 ASR（Qwen3 实时识别）→ 快脑 LLM（DeepSeek，禁用思考、首句一成形即合成）→ TTS（MiniMax，逐句合成 + 预合成消除句间空档）。每句情绪 `[emotion:tag]` piggyback 在 LLM 输出里，不额外调模型；笑/叹气用拟声标签真发声。回声/语气词/ASR 幻听过滤防自打断与凭空冒话。
- **记忆 / 人格**：Postgres + `pgvector` 语义召回（相似度 × 时间衰减 × 情感权重）；离线理解引擎（慢脑 Qwen-Long + Bailian embedding）在挂断后回写事实/画像、推进角色自主状态 —— "她有对话之外的生命"。
- **服务进程**：单进程同时跑 WebSocket 信令 + 运营 API（127.0.0.1:8788）+ 用户账号 API（127.0.0.1:8789）；外网经 nginx 反代 + Let's Encrypt HTTPS。后端零三方依赖于核心逻辑、需 Python ≥ 3.11。

## 仓库结构

```
docs/                         项目宪法 + 三轨规格（开发唯一依据）
  CLAUDE.md                   ← 最先读：两条第一性原理、四层防线、三轨结构、节点选型、全局铁律
  01-角色资产生成规范.md        资产轨
  02-后端架构与实现规格.md      后端轨
  03-前端对接规格.md            前端轨
prototype/                    DC 原型（视觉/交互/文案的唯一真相，已冻结）
frontend/                     ✅ 用户端 H5 生产前端 —— 见 frontend/README.md
admin/                        ✅ 运营管理端 —— 见 admin/README.md
backend/                      ✅ 实时管线 + 记忆/人格 + 服务端权威计费 —— 见 backend/README.md
asset-pipeline/               ✅ 角色 spec / 校验 / 导入导出
deploy/                       ✅ systemd + nginx + certbot + coturn + Postgres 部署 —— 见 deploy/README.md
```

## 三轨进度（全部已落地、线上运行）

| 轨道 | 说明 | 状态 |
|---|---|---|
| **前端复刻轨**（确定性） | `AI Call.dc.html` → 生产 React，mock 换服务端信令 | ✅ 线上（`frontend/`） |
| **后端四层防线轨** | 实时管线 / 单轮质量 / 记忆人格 / 自主演进 | ✅ 线上（`backend/`） |
| **资产管线轨** | 角色 spec、生成工作流、导入导出校验 | ✅ 已落地（`asset-pipeline/`） |
| **Admin 后台** | `MiCall Admin.dc.html` → 运营管理端 | ✅ 线上（`admin/`） |

## 运行

**后端**（核心逻辑测试无三方依赖，但需 **Python ≥ 3.11**）：
```bash
cd backend
PYTHONPATH=src python3 -m tests              # 单元测试（145 passed）
PYTHONPATH=src python3 -m micall.cli run-server   # 起 WS 信令 + 运营/用户 API（本地监听）
```

**用户端 H5**：
```bash
cd frontend && npm install
npm run dev      # 内置 mock 信令，无需后端即可独立运行
npm run build    # 类型检查 + 生产构建
```

**运营后台**：
```bash
cd admin && npm install
npm run dev
npm run build
```

## 部署与安全

线上部署（阿里云 ECS：systemd 守护后端、nginx 反代三站、certbot 签发 HTTPS、coturn 做 TURN/STUN、Postgres+pgvector 持久化）见 [`deploy/README.md`](deploy/README.md)。

安全基线（后端 fail closed，详见 deploy/README.md）：
- 后台鉴权：**必须**设强 `MICALL_ADMIN_PASSWORD` + 长随机 `MICALL_ADMIN_TOKEN`；未安全配置时 `/admin/login`→503、其余 `/admin/*`→401（绝不裸奔）。
- CORS 白名单（admin / 用户端各自域名），不反射任意来源、不对未知来源放行携带凭据。
- nginx 安全响应头：HSTS / X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy。
- 密钥走环境变量 / 服务端配置（铁律2），永不入库。
