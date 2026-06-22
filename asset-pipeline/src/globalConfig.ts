// 全局视觉配置 + 全局行为默认（docs/01 §3 / §2.5 / §6.1）。
import type { GlobalDefaults, GlobalVisualConfig } from "./schema.ts";

// 所有角色、所有片段共享的固定背景与镜头语言。背景不随角色变、不随场景变 —— 这是跨段/
// 跨角色一致性的硬约束（漂移 B 的根治）。建议与前端视觉语言衔接：柔光氛围、暖色调、虚化。
export const GLOBAL_VISUAL_CONFIG: GlobalVisualConfig = {
  background:
    "统一固定背景：柔光的室内夜色氛围，暖色调，背景大幅虚化、不抢主体；与前端浅色渐变视觉语言衔接，所有角色共用同一张背景。",
  composition: "上半身像，居中，正面略偏，固定机位无推拉",
  lighting: "暖色调柔光，主光源左前方约45度，背景虚化",
  camera: "中景，平视视角，浅景深",
  style: "写实偏柔和，电影感，自然肤质",
  spec: { resolution: "720x960", fps: 30, loop_seamless: true },
  loop_duration_range: "8-15s",
  negative: "无多余文字、无logo、不变形、不闪烁、构图不偏移、风格不突变、背景不变化",
};

// 行为参数的全局默认（可被角色 runtime_overrides / 用户自定义覆盖；视觉/背景不可覆盖）。
// 与 Admin「接口配置」对齐：快脑 DeepSeek-V4-Flash 回复上限 256、Embedding 检索 Top-K 5。
export const GLOBAL_DEFAULTS: GlobalDefaults = {
  tts_model: "speech-02-turbo", // MiniMax 默认 TTS 模型
  default_voice: "female-shaonv-01",
  memory_depth: 5, // 记忆检索 Top-K
  reply_max_tokens: 256,
  visual: GLOBAL_VISUAL_CONFIG,
};
