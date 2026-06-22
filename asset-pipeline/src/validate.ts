// 导入校验闸门（docs/01 §6 / §7）。
//
// 一致性靠「共享锚」在数据层强制，不靠运行时修、不靠人工保证。校验分两层：
//   • spec 级：纯逻辑校验（必填、锚定继承、loops_spec↔emotion_map 对齐…）
//   • 资产级：吃外部探测的 ClipProbe（首尾帧/跨段/构图/规格），逻辑仍是纯函数、可测试。
// 不过关的项标 error（拒绝入库）；建议项标 warn（不阻断）。
import type {
  CharacterSpec,
  ClipProbe,
  GlobalVisualConfig,
  ValidationIssue,
  ValidationReport,
} from "./schema.ts";

export const THRESHOLDS = {
  firstLastSimilarity: 0.85, // 防漂移 A：首尾不接 → 跳变
  baseAlignment: 0.8, // 防漂移 B：与基准不一致 → 切换瞬移
  compositionDrift: 0.15, // 段内位置/大小漂移上限
  durationMin: 8,
  durationMax: 15,
};

const VOICE_PROVIDERS = new Set(["minimax", "MiniMax"]);
const ID_RE = /^[a-z][a-z0-9_]{1,40}$/; // 稳定、小写、全链路引用
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function err(gate: string, message: string, field?: string): ValidationIssue {
  return { gate, level: "error", message, field };
}
function warn(gate: string, message: string, field?: string): ValidationIssue {
  return { gate, level: "warn", message, field };
}

/** spec 级校验（不需要资产产物）。 */
export function validateSpec(spec: CharacterSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const id = spec.identity?.character_id;

  // 身份与版本
  if (!id || !ID_RE.test(id)) issues.push(err("identity", `character_id「${id}」非法：需小写字母开头、仅含 a-z0-9_`, "identity.character_id"));
  if (!spec.identity?.name) issues.push(err("identity", "缺少 name", "identity.name"));
  if (!VERSION_RE.test(spec.identity?.version || "")) issues.push(err("identity", `version「${spec.identity?.version}」需为语义化 x.y.z`, "identity.version"));

  // 人格内核：hidden_layer / values_and_boundaries 不可省（真人感的人格基础）
  if (!spec.persona?.values_and_boundaries?.trim()) issues.push(err("persona", "values_and_boundaries 不可省（去讨好的依据）", "persona.values_and_boundaries"));
  if (!spec.persona?.hidden_layer?.trim()) issues.push(err("persona", "hidden_layer 不可省（未言明的「冰山」）", "persona.hidden_layer"));
  if (!spec.persona?.core_traits?.length) issues.push(warn("persona", "core_traits 为空：建议 2-3 个少而硬的核心特质", "persona.core_traits"));

  // 视觉：必须全局继承，subject 只描述本人
  if (spec.visual?.master_prompt?.inherit !== "global_visual_config") issues.push(err("visual", "master_prompt.inherit 必须为 'global_visual_config'（背景/构图全局继承）", "visual.master_prompt.inherit"));
  if (!spec.visual?.master_prompt?.subject?.trim()) issues.push(err("visual", "master_prompt.subject 不能为空", "visual.master_prompt.subject"));

  // 铁律：loops_spec 的状态 key 必须与 voice.emotion_map 的 key 对齐
  const loopKeys = Object.keys(spec.visual?.loops_spec || {});
  const emoKeys = new Set(Object.keys(spec.voice?.emotion_map || {}));
  if (!loopKeys.length) issues.push(err("visual", "loops_spec 为空：至少要有 idle/listening/speaking", "visual.loops_spec"));
  for (const k of loopKeys) {
    if (!emoKeys.has(k)) issues.push(err("alignment", `loops_spec 状态「${k}」在 voice.emotion_map 中无对应（一个情绪标签要同时查视频段和语音 emotion）`, "voice.emotion_map"));
    const cnt = spec.visual.loops_spec[k].count;
    if (!(cnt >= 1)) issues.push(err("visual", `loops_spec「${k}」.count 需 ≥ 1`, `visual.loops_spec.${k}.count`));
  }
  if (loopKeys.includes("idle") && (spec.visual.loops_spec.idle.count || 0) < 2) issues.push(warn("visual", "idle 建议备 2-3 段随机穿插，打散周期感", "visual.loops_spec.idle.count"));

  // 音色
  if (!VOICE_PROVIDERS.has(spec.voice?.provider)) issues.push(warn("voice", `voice.provider「${spec.voice?.provider}」非 minimax`, "voice.provider"));
  if (!spec.voice?.voice_brief?.trim()) issues.push(err("voice", "voice_brief 不能为空（喂 MiniMax 生成/克隆）", "voice.voice_brief"));

  // 产物缺失：spec 阶段允许（资产尚未生成），仅 warn 提示
  if (!spec.visual?.master_frame_url) issues.push(warn("asset", "master_frame_url 为空：基准图尚未生成", "visual.master_frame_url"));
  if (!spec.voice?.voice_id) issues.push(warn("asset", "voice_id 为空：音色尚未绑定", "voice.voice_id"));
  for (const k of loopKeys) {
    const urls = spec.visual.loops_url?.[k] || [];
    const need = spec.visual.loops_spec[k].count;
    if (urls.length && urls.length < need) issues.push(warn("asset", `状态「${k}」产物 ${urls.length} 段 < count ${need}`, `visual.loops_url.${k}`));
  }

  return issues;
}

function parseResolution(s: string): { w: number; h: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  return m ? { w: +m[1], h: +m[2] } : null;
}

/** 资产级校验：吃 ClipProbe（已由探测器提取首尾帧/SSIM 等）。 */
export function validateAssets(probes: ClipProbe[], g: GlobalVisualConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const target = parseResolution(g.spec.resolution);
  for (const p of probes) {
    const tag = `[${p.state}] ${p.url}`;
    // 闸门4 规格校验
    if (target && (p.width !== target.w || p.height !== target.h)) issues.push(err("spec", `${tag} 分辨率 ${p.width}x${p.height} ≠ 全局 ${g.spec.resolution}`, p.state));
    if (p.durationSec < THRESHOLDS.durationMin || p.durationSec > THRESHOLDS.durationMax) issues.push(err("spec", `${tag} 时长 ${p.durationSec}s 不在 ${THRESHOLDS.durationMin}-${THRESHOLDS.durationMax}s`, p.state));
    if (p.fps !== g.spec.fps) issues.push(warn("spec", `${tag} 帧率 ${p.fps} ≠ 全局 ${g.spec.fps}`, p.state));
    // 闸门1 首尾帧一致性（防漂移 A）
    if (p.firstLastSimilarity < THRESHOLDS.firstLastSimilarity) issues.push(err("driftA", `${tag} 首尾不接（相似度 ${p.firstLastSimilarity.toFixed(2)} < ${THRESHOLDS.firstLastSimilarity}），循环会跳变`, p.state));
    // 闸门2 跨段对齐基准（防漂移 B）
    if (p.baseAlignment < THRESHOLDS.baseAlignment) issues.push(err("driftB", `${tag} 与基准不一致（${p.baseAlignment.toFixed(2)} < ${THRESHOLDS.baseAlignment}），切换会瞬移`, p.state));
    // 闸门3 构图稳定性
    if (p.compositionDrift > THRESHOLDS.compositionDrift) issues.push(err("composition", `${tag} 构图漂移 ${p.compositionDrift.toFixed(2)} > ${THRESHOLDS.compositionDrift}（位置/大小不稳）`, p.state));
  }
  return issues;
}

/** 完整闸门：spec 级 +（可选）资产级，汇成一份报告。无 error 即 passed。 */
export function validateCharacter(
  spec: CharacterSpec,
  g: GlobalVisualConfig,
  probes?: ClipProbe[],
): ValidationReport {
  const issues = [...validateSpec(spec)];
  if (probes && probes.length) issues.push(...validateAssets(probes, g));
  return {
    character_id: spec.identity?.character_id || "",
    passed: !issues.some((i) => i.level === "error"),
    issues,
    checked_at: new Date().toISOString(),
  };
}
