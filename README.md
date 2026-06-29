# 载思 zsky · MiCall.ai

让用户**感觉在和一个真实的人通话**的移动端（H5）AI 语音陪伴产品。
已上线运行于阿里云香港 —— 用户端 [`zsky.com`](https://zsky.com)、运营后台 `admin.zsky.com`。

> 开发的最高纲领是 [`docs/CLAUDE.md`](docs/CLAUDE.md)（项目宪法）。任何开发决策以它和三份规格文档为准。

## 产品形态

- **用户端 H5**：点开角色即进入**全双工语音通话** —— 可随时打断、你来我往、像真人聊天；接通有起势、挂断有收势，球随真实声纹呼吸，字幕跟着语音逐句流出。支持中 / 英双语 UI 与对话语言。
- **角色有"灵魂"**：多层 context 叠加 —— 角色人设（出厂资产 + 性格内核） + 关系/画像（per-user，双向身份） + 情节记忆（语义召回） + 角色自主状态（独立于用户的"今天心情/近况"） + 世界库（真实天气 / 真实热点）。她会记得你、有自己的生活与小脾气，不是单向应答的客服。
- **会学习的陪伴**：挂断后离线"慢脑"回写事实/画像/洞察、推进角色自己的生活；用户的**通话评价**也会回写到画像，下一通让 AI 据真人反馈校准对你的表现。
- **运营后台**：角色管理（人设 / 内核 / 说话风格 / 基础资料 / 音色全字段可编辑、可新建、可 AI 生成、可音色克隆）、接口配置（endpoint/key 存服务端）、用户 / 订单 / 通话（含转写内容）/ 成本看板、世界库与热点源体检、邀请裂变、工单、手动增减时长、分页。

## 让"像真人"成立的几件事

- **实时媒体（自建，不依赖商业 RTC 厂商）**：浏览器原生 `RTCPeerConnection` + 自建 [`aiortc`](https://github.com/aiortc/aiortc)（Python）+ 自建 coturn（TURN/STUN）做全双工 RTC；硬件回声消除（AEC）只在 RTC 媒体面成立。WebSocket（TCP/443）作为兜底音频通道，RTC 真正连上前先走 WS、连上即切，启动不阻塞。
- **流式管线（首句抢跑，~1.2–1.6s 首音）**：实时 ASR → 快脑 LLM（流式、禁用思考、首句一成形即合成）→ TTS（逐句合成 + 并行预合成消除句间空档）。每句情绪 `[emotion:tag]` piggyback 在 LLM 输出里、不额外调模型；笑/叹气用拟声标签真发声。回声/语气词/ASR 幻听过滤防自打断与凭空冒话；`frequency_penalty` + 反复读护栏压"车轱辘话"。
- **开场利落、打不断那句必须短**：接通后 AI 主动开口，开场期 ASR 抑制（防把自己开场白当用户插话），故开场单独用更短的 token 上限、指令也要求"就一句、把话头递出去就停"；选了具体情境（模拟面试 / 哄睡 / 练口语 / 成语接龙）则开场直接顺着情境进场，由人设来演。
- **记忆带"信而核验"**：离线慢脑产出的"共同经历/事实"会拿**真实对话记录**核对，凭空编造的当场丢弃 —— 从源头堵"我们上次聊过 X"的幻觉，而非逐条加提示词打补丁。
- **抗抖动 / 不半路死掉**：provider 瞬时错误（限流/网关抖/超时）首字节前自动退避重试；一轮失败优雅回 listening 不卡"思考中"；网络整条掉线后窗口内**重拨同一角色 + 同一场景即续接**（回灌最近几轮、AI 不重新自我介绍、字幕承接；换了场景则干净进新场景）；拨号兜底超时不让用户卡在"接通中"；`/api/health` 供监控探活。

## 记忆与人格（多层 context）

| 层 | 内容 | 存储 / 来源 |
|---|---|---|
| 人设（出厂） | 角色定义 + 性格**内核** + 情绪→韵律映射 + 角色级口吻微调 | 资产 spec（38 个出厂角色） |
| 关系 / 画像（per-user×角色） | 事实档案、人格洞察（按置信度演化）、稳定原则、好奇缺口、未了线头、**双向羁绊**（角色这一侧对你的感情/被你改变） | Postgres `user_profile` |
| 情节记忆 | 语义召回：相似度 × **重要性** × 情感权重（时间新近为辅 —— 优先想起 TA 真在意的事） | Postgres + `pgvector`，向量 embedding |
| 角色自主状态 | 独立于用户的"今天心情 / 最近在经历 / 期待的事"，离线随时间自传式推进 | per-角色，全站快照 |
| 世界库 | 各城**真实天气**（open-meteo）+ 一池**真实热点**（免费 RSS/JSON + 维基「历史上的今天」，慢脑改写成口语、过安全闸、带原文链接、随时间衰减遗忘） | 全站共享，周期刷新 |
| 反馈校准 | 用户挂断后的星级 + 标签 → 派生一句校准写进画像，下一通注入让 AI 据真人反馈调整 | Postgres `user_profile` |

离线"慢脑"（推理型 LLM 节点）在挂断后回写画像、推进自主状态与世界，并发封顶不抢在线接话 —— **"她有对话之外的生命"**。

## 管线节点（可插拔；真实 provider/模型在运营后台设定，不在仓库）

后端按「节点」抽象，每个节点是一个可插拔的 provider 适配器。**每个节点实际用哪家 provider / endpoint / 模型 / key，都在运营后台「接口配置」里按部署设定、存服务端，不入仓库。** 仓库里的 `backend/config/default.json` 只是占位模板，**不代表线上实际所用模型**；留空 key 的节点会自动回退（如 `llm_eval`→`llm_slow`→`llm_fast`）。

| 节点 | 在链路里的角色 |
|---|---|
| `asr` | 实时语音识别 |
| `llm_fast` | 通话快脑（流式、禁思考、首句抢跑） |
| `tts` | 逐句语音合成（情绪韵律、拟声） |
| `llm_slow` | 离线理解 / 自主状态推进（慢脑） |
| `embedding` | 情节记忆语义召回 |
| `llm_eval` | 图灵测试裁判 / 后台「AI 生成角色·内核」 |
| `llm_search` | 真实热点改写成口语（grounded，不联网编造） |

## 服务进程

单进程同时跑 WebSocket 信令 + 运营 API（127.0.0.1:8788）+ 用户账号 API（127.0.0.1:8789）；外网经 nginx 反代 + Let's Encrypt HTTPS。核心逻辑零三方依赖、需 **Python ≥ 3.11**。

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
backend/                      ✅ 实时管线 + 记忆/人格 + 世界库 + 服务端权威计费 —— 见 backend/README.md
asset-pipeline/               ✅ 角色 spec（38 个出厂角色）/ 校验 / 导入导出
deploy/                       ✅ systemd + nginx + certbot + coturn + Postgres 部署 —— 见 deploy/README.md
```

## 运行

**后端**（核心逻辑测试无三方依赖，但需 **Python ≥ 3.11**）：
```bash
cd backend
PYTHONPATH=src python3 -m unittest discover -s tests -q   # 单元测试（386 passed）
PYTHONPATH=src python3 -m micall.cli selfcheck            # 报告配置 + 各节点状态
PYTHONPATH=src python3 -m micall.cli run-server           # 起 WS 信令 + 运营/用户 API（本地监听）
```

**用户端 H5**：
```bash
cd frontend && npm install
npm run dev            # 内置 mock 信令，无需后端即可独立运行
npm run build          # 类型检查 + 生产构建
npm run lint:bindings  # 校验模板 {{ }} 绑定（防空白 UI）
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
- 后台鉴权：**必须**设强 `MICALL_ADMIN_PASSWORD` + 长随机 `MICALL_ADMIN_TOKEN`；未安全配置时 `/admin/login`→503、其余 `/admin/*`→401（绝不裸奔）。用户端 WS 凭据走首条消息、不进 URL。
- 服务端权威计费：余额/时长以服务端为准，前端只显示；挂断/掉线/复用连接都先结算再新建，不丢账。
- CORS 白名单（admin / 用户端各自域名），不反射任意来源、不对未知来源放行携带凭据。
- 隐私：通话语音仅实时对话用、不训练、结束即弃；游客记忆按 IP 隔离不串台；同意留痕。
- nginx 安全响应头：HSTS / X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy。
- 密钥走环境变量 / 服务端配置（铁律2），永不入库。
