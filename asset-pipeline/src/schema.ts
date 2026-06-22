// MiCall 角色 spec 的数据结构（docs/01-角色资产生成规范.md §3/§4）。
//
// 核心思想：角色的本体是一份「生成规范（spec）」，资产（图/视频/音色）是这份 spec 的
// 编译产物。资产丢了能重做，迁移环境能重建，批量造角色就是批量填 spec。

// ─────────────────────────── 全局视觉配置（§3）───────────────────────────
// 背景/构图/光线/机位/风格全部在全局层定义；单个角色不得自定义这些字段，从结构上强制
// 一致（漂移 B 的根治）。背景是全局常量，不可被角色或用户覆盖。
export interface GlobalVisualConfig {
  background: string;
  composition: string;
  lighting: string;
  camera: string;
  style: string;
  spec: { resolution: string; fps: number; loop_seamless: boolean };
  loop_duration_range: string;
  negative: string;
}

// ─────────────────────────── 单个角色 spec（§4）───────────────────────────
export interface CharacterIdentity {
  character_id: string; // 唯一稳定 ID，全链路引用，永不改
  name: string;
  version: string; // 角色版本，便于资产迭代/回滚（语义化 x.y.z）
  tagline: string;
  gender: string;
  age: number;
  appearance: string; // 喂 Coze 出图的外貌
  nationality: string;
  profile: { height_cm: number; weight_kg: number; birthday: string; race: string };
}

export interface CharacterPersona {
  core_traits: string[];
  speaking_style: string;
  values_and_boundaries: string; // 去讨好的依据 —— 不可省
  background_story: string;
  hidden_layer: string; // 未言明的「冰山」—— 不可省
  likes: string[];
  dislikes: string[];
}

export interface LoopSpecEntry {
  micro_motion: string; // 只描述「在基准上多做什么微动作」
  count: number; // 该状态备几段（待机建议 2-3 段随机穿插）
}

export interface CharacterVisual {
  master_prompt: {
    subject: string; // 只描述角色本人
    inherit: "global_visual_config"; // 背景/构图/光线/机位/风格/负向词全局继承
  };
  master_frame_url: string; // 基准图产物，可重生成
  // 状态 key 必须与 voice.emotion_map 的 key 对齐
  loops_spec: Record<string, LoopSpecEntry>;
  loops_url: Record<string, string[]>; // 各状态视频产物，可重生成
  common_constraints: string;
}

export interface CharacterVoice {
  provider: string; // e.g. "minimax"
  voice_brief: string; // 喂 MiniMax 生成/克隆
  reference_audio_url: string; // 克隆参考音频（可选，空串表示无）
  minimax_params: { model: string; default_emotion: string };
  voice_id: string; // MiniMax 返回的产物，绑定后回填（空串表示未生成）
  emotion_map: Record<string, string>; // 情绪标签 → MiniMax emotion 参数
}

// 可选：覆盖全局默认（§2.5）；缺省则用全局默认。
export interface RuntimeOverrides {
  tts_model?: string | null;
  realtime_prompt_extra?: string;
  memory_depth?: number | null;
  reply_max_tokens?: number | null;
}

export interface CharacterMeta {
  created_at: string;
  updated_at: string;
  seedance_version: string;
  validation: { passed: boolean; report: string };
  checksum: string;
}

export interface CharacterSpec {
  identity: CharacterIdentity;
  persona: CharacterPersona;
  visual: CharacterVisual;
  voice: CharacterVoice;
  runtime_overrides?: RuntimeOverrides;
  meta: CharacterMeta;
}

// ──────────────────── 全局默认（行为参数，可被角色/用户覆盖）────────────────────
// 注意：视觉/背景是全局固定、不可覆盖；这里是「行为参数」的全局默认（§2.5/§6.1）。
export interface GlobalDefaults {
  tts_model: string;
  default_voice: string;
  memory_depth: number; // 记忆检索 Top-K
  reply_max_tokens: number;
  visual: GlobalVisualConfig;
}

// ─────────────────────── 资产探测数据（用于资产级校验）───────────────────────
// 由外部探测器（ffprobe + 首尾帧抽取 + 感知哈希/SSIM）填充；校验逻辑只吃这份数据，
// 因此校验是纯函数、可测试。
export interface ClipProbe {
  state: string;
  url: string;
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  /** 首帧 vs 尾帧 相似度 0~1（防漂移 A：循环跳变） */
  firstLastSimilarity: number;
  /** 首帧 vs master_frame 相似度 0~1（防漂移 B：切换瞬移） */
  baseAlignment: number;
  /** 段内角色位置/大小最大漂移 0~1（0=完全稳定） */
  compositionDrift: number;
}

export interface MediaProber {
  probe(url: string, masterFrameUrl: string): Promise<ClipProbe>;
}

// ───────────────────────────── 校验报告 ─────────────────────────────
export type IssueLevel = "error" | "warn";
export interface ValidationIssue {
  gate: string;
  level: IssueLevel;
  field?: string;
  message: string;
}
export interface ValidationReport {
  character_id: string;
  passed: boolean; // 无 error 即通过（warn 不阻断入库）
  issues: ValidationIssue[];
  checked_at: string;
}
