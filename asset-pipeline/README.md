# MiCall 资产管线轨（角色 spec / 校验 / 导入导出）

实现 `docs/01-角色资产生成规范.md`：**角色的本体是一份「生成规范（spec）」，资产（图/
视频/音色）是这份 spec 的编译产物**。资产丢了能重做、迁移环境能重建、批量造角色就是批量
填 spec。这是「喂料系统」——先有它才有角色可用。

## 能力

| 模块 | 文件 | 作用 |
|---|---|---|
| 角色 spec 类型 | `src/schema.ts` | identity / persona / visual / voice / runtime_overrides / meta，+ 全局视觉配置、ClipProbe、校验报告 |
| 全局视觉/默认 | `src/globalConfig.ts` | 全局固定背景与镜头语言（§3）+ 行为参数全局默认（§2.5/§6.1） |
| Prompt 派生 | `src/prompts.ts` | 锚定层 + 派生层（§5）：master_prompt = subject + 全局；video_prompt = master_prompt + 微动作，**绝不重写主体** |
| 三级配置覆盖 | `src/overrides.ts` | 用户自定义 > 角色配置 > 全局默认（音色/TTS/记忆深度/回复长度）；视觉/背景全局固定不可覆盖 |
| 导入校验闸门 | `src/validate.ts` | spec 级（必填、锚定继承、`loops_spec↔emotion_map` 对齐…）+ 资产级（防漂移 A/B、构图、规格） |
| 导入/导出 | `src/bundle.ts` | 跑闸门、回写 `meta.validation`/`checksum`；导出 `micall_characters.json`（可移植、可重建） |
| CLI | `src/cli.ts` | `validate` / `export` / `prompts` / `new` |
| 样例角色 | `characters/lin_wan.json` | 填好的完整 spec（林晚），造其他角色的模板 |

## 防漂移闸门（§6/§7）

不靠运行时修、不靠人工，**入库时用规范卡死**：

- **漂移 A（单段首尾不接）**：每段首帧 vs 尾帧相似度 ≥ 0.85，否则标红「会跳变」。
- **漂移 B（跨段/跨角色不一致）**：每段首帧 vs `master_frame` 相似度 ≥ 0.80，否则「切换瞬移」。
- **构图稳定性**：段内位置/大小漂移 ≤ 0.15。
- **规格**：分辨率 = 全局 720x960、时长 8-15s、帧率统一 30。
- **对齐铁律**：`loops_spec` 状态 key 必须与 `voice.emotion_map` 的 key 对齐（一个情绪标签同时
  查「切哪段视频」和「用哪个语音 emotion」）。

> 资产级校验吃外部探测的 `ClipProbe`（分辨率/时长/帧率/首尾帧相似度/基准对齐/构图漂移），
> 校验逻辑是纯函数、可测试。生产里由探测器（`ffprobe` + 首尾帧抽取 + 感知哈希/SSIM）填充
> `ClipProbe`，实现 `MediaProber` 接口即可接入；本轮先把规范与逻辑闸门做实。

## 工作流（§1）

```
填角色 spec → master_prompt 投 Coze → 基准图(master_frame)
  → master_prompt + micro_motion 投 Coze/Seedance（以基准图为首帧）→ 各状态循环视频
  → voice_brief 投 MiniMax → voice_id（回填）
  → 导出 micall_characters.json → 后台导入跑校验闸门入库
```

`prompts` 命令直接产出喂 Coze 的 master/video prompt；外部生成回产物后回填 url，再 `validate`。

## 用法

```bash
cd asset-pipeline && npm install
npm test                                   # 校验闸门 / prompt 派生 / 覆盖 / 导入导出 测试
npx tsx src/cli.ts validate characters/lin_wan.json
npx tsx src/cli.ts validate characters/lin_wan.json --probes probes.json   # 带资产探测
npx tsx src/cli.ts prompts  characters/lin_wan.json --state idle
npx tsx src/cli.ts export   characters -o micall_characters.json
npx tsx src/cli.ts new      jiang_ye --name 江野 > characters/jiang_ye.json
```

## 与 Admin / 后端的衔接

- Admin「角色导入/导出」：导入 = 选资产包 → 跑本轨闸门（不过关标红、拒绝入库）；导出 =
  `exportCharacters` → `micall_characters.json`，供大模型读取后再生成音色与表情资产。
- 后端实时路径：用 `resolveRuntimeConfig(char, global, userVoice)` 解出 voice_id / tts_model /
  memory_depth / reply_max_tokens / realtime_prompt_extra（三级覆盖），背景永远走全局固定。
