// Prompt 派生：锚定层 + 派生层（docs/01 §5）。
//
// 防漂移在 prompt 层的体现：基准图 prompt 是「锚」，视频 prompt = 锚 + 微动作增量，
// 绝不重写主体。主体描述一字之差，Coze 生成的脸/构图就会变，跨段就漂移。
import type { CharacterSpec, GlobalVisualConfig } from "./schema.ts";

/**
 * master_prompt（基准图，锚）= subject + 全局的 composition/lighting/camera/style/
 * background/negative。所有视频 prompt 都继承它。
 */
export function buildMasterPrompt(spec: CharacterSpec, g: GlobalVisualConfig): string {
  const s = spec.visual.master_prompt.subject;
  return [
    `主体：${s}`,
    `构图：${g.composition}`,
    `光线：${g.lighting}`,
    `机位：${g.camera}`,
    `风格：${g.style}`,
    `背景：${g.background}`,
    `负向词：${g.negative}`,
  ].join("\n");
}

/**
 * video_prompt[state] = master_prompt + 该状态的 micro_motion。
 * 铁律：永远 = master_prompt + 微动作，绝不重写 subject/背景/构图；增量只描述「在基准上
 * 多做什么微动作」。以 master_frame 为 image-to-video 首帧。
 */
export function buildVideoPrompt(spec: CharacterSpec, g: GlobalVisualConfig, state: string): string {
  const entry = spec.visual.loops_spec[state];
  if (!entry) throw new Error(`loops_spec 缺少状态「${state}」`);
  return [
    buildMasterPrompt(spec, g),
    `微动作（在基准上叠加，不改主体/构图/背景）：${entry.micro_motion}`,
    `约束：${spec.visual.common_constraints}`,
    `首帧：以 master_frame 为 image-to-video 首帧；首尾姿态回到基准。`,
  ].join("\n");
}

/** 为角色的每个状态派生视频 prompt（喂 Coze/Seedance 的生成依据）。 */
export function buildAllVideoPrompts(spec: CharacterSpec, g: GlobalVisualConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const state of Object.keys(spec.visual.loops_spec)) {
    out[state] = buildVideoPrompt(spec, g, state);
  }
  return out;
}
