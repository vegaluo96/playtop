// Asset-pipeline tests: schema validation gates, prompt derivation, three-tier
// overrides, and bundle import/export. Pure logic, no external services.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GLOBAL_DEFAULTS, GLOBAL_VISUAL_CONFIG } from "../src/globalConfig.ts";
import { validateSpec, validateAssets, validateCharacter } from "../src/validate.ts";
import { buildMasterPrompt, buildVideoPrompt } from "../src/prompts.ts";
import { resolveRuntimeConfig, resolveVoiceId } from "../src/overrides.ts";
import { importCharacter, checksum, exportCharacters, parseCharacter } from "../src/bundle.ts";
import type { CharacterSpec, ClipProbe } from "../src/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const linWan = parseCharacter(readFileSync(join(here, "../characters/lin_wan.json"), "utf8"));
const clone = (): CharacterSpec => JSON.parse(JSON.stringify(linWan));

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log("✓ " + label);
  else { failures++; console.error("✗ " + label); }
}
const errs = (spec: CharacterSpec) => validateSpec(spec).filter((i) => i.level === "error");
const hasGate = (spec: CharacterSpec, gate: string) => validateSpec(spec).some((i) => i.gate === gate && i.level === "error");

// ── spec 校验 ──────────────────────────────────────────────────────────────
ok("样例角色 林晚 spec 通过（无 error）", errs(linWan).length === 0);

{ const s = clone(); s.persona.hidden_layer = ""; ok("hidden_layer 不可省", hasGate(s, "persona")); }
{ const s = clone(); s.persona.values_and_boundaries = "  "; ok("values_and_boundaries 不可省", hasGate(s, "persona")); }
{ const s = clone(); delete (s.voice.emotion_map as any).caring; ok("loops_spec↔emotion_map 不对齐 → error", hasGate(s, "alignment")); }
{ const s = clone(); s.identity.character_id = "Lin-Wan!"; ok("非法 character_id → error", hasGate(s, "identity")); }
{ const s = clone(); s.identity.version = "1.0"; ok("非语义化 version → error", hasGate(s, "identity")); }
{ const s = clone(); (s.visual.master_prompt as any).inherit = "nope"; ok("master_prompt 不继承全局 → error", hasGate(s, "visual")); }
{ const s = clone(); s.voice.voice_id = ""; const r = validateSpec(s); ok("voice_id 空 → warn 不阻断", r.some((i) => i.gate === "asset" && i.level === "warn") && !r.some((i) => i.level === "error")); }

// ── 资产级校验 ──────────────────────────────────────────────────────────────
const goodProbe = (state: string): ClipProbe => ({ state, url: `x/${state}.mp4`, width: 720, height: 960, durationSec: 12, fps: 30, firstLastSimilarity: 0.95, baseAlignment: 0.9, compositionDrift: 0.05 });
ok("合格资产无 error", validateAssets([goodProbe("idle"), goodProbe("listening")], GLOBAL_VISUAL_CONFIG).filter((i) => i.level === "error").length === 0);
ok("首尾不接(漂移A) → error", validateAssets([{ ...goodProbe("idle"), firstLastSimilarity: 0.5 }], GLOBAL_VISUAL_CONFIG).some((i) => i.gate === "driftA"));
ok("与基准不齐(漂移B) → error", validateAssets([{ ...goodProbe("idle"), baseAlignment: 0.4 }], GLOBAL_VISUAL_CONFIG).some((i) => i.gate === "driftB"));
ok("分辨率不符 → error", validateAssets([{ ...goodProbe("idle"), width: 1080, height: 1920 }], GLOBAL_VISUAL_CONFIG).some((i) => i.gate === "spec"));
ok("时长越界 → error", validateAssets([{ ...goodProbe("idle"), durationSec: 20 }], GLOBAL_VISUAL_CONFIG).some((i) => i.gate === "spec"));
ok("构图漂移过大 → error", validateAssets([{ ...goodProbe("idle"), compositionDrift: 0.5 }], GLOBAL_VISUAL_CONFIG).some((i) => i.gate === "composition"));

// ── prompt 派生（锚定层 + 派生层）─────────────────────────────────────────────
const master = buildMasterPrompt(linWan, GLOBAL_VISUAL_CONFIG);
ok("master_prompt 含 subject", master.includes(linWan.visual.master_prompt.subject));
ok("master_prompt 含全局背景", master.includes(GLOBAL_VISUAL_CONFIG.background));
const vIdle = buildVideoPrompt(linWan, GLOBAL_VISUAL_CONFIG, "idle");
ok("video_prompt = master_prompt + 微动作（锚不被重写）", vIdle.startsWith(master) && vIdle.includes(linWan.visual.loops_spec.idle.micro_motion));

// ── 三级覆盖 ────────────────────────────────────────────────────────────────
ok("音色：角色 voice_id 优先于全局默认", resolveVoiceId(linWan, GLOBAL_DEFAULTS) === "female-shaonv-01");
ok("音色：用户自定义最高优先", resolveVoiceId(linWan, GLOBAL_DEFAULTS, { user_id: "u1", character_id: "lin_wan", voice_id: "user-clone-9" }) === "user-clone-9");
{ const s = clone(); s.voice.voice_id = ""; ok("音色：角色与用户都缺 → 回退全局默认", resolveVoiceId(s, GLOBAL_DEFAULTS) === GLOBAL_DEFAULTS.default_voice); }
{ const rc = resolveRuntimeConfig(linWan, GLOBAL_DEFAULTS); ok("runtime_overrides 缺省回退全局（memory_depth/reply_max_tokens）", rc.memory_depth === GLOBAL_DEFAULTS.memory_depth && rc.reply_max_tokens === GLOBAL_DEFAULTS.reply_max_tokens && rc.realtime_prompt_extra.length > 0); }

// ── 导入 / 导出 ─────────────────────────────────────────────────────────────
const imp = importCharacter(linWan, GLOBAL_DEFAULTS);
ok("导入回写 meta.validation.passed", imp.spec.meta.validation.passed === true);
ok("导入回写 checksum", imp.spec.meta.checksum.startsWith("sha256:"));
ok("checksum 稳定（同 spec 同值）", checksum(linWan) === checksum(JSON.parse(JSON.stringify(linWan))));
{ const s = clone(); s.persona.speaking_style += "改一下"; ok("checksum 随内容变化", checksum(s) !== checksum(linWan)); }
const bundle = exportCharacters([linWan], GLOBAL_DEFAULTS);
ok("导出 micall_characters.json 结构完整", bundle.$schema_version === "1.0" && bundle.characters.length === 1 && !!bundle.global_visual_config.background && bundle.characters[0].report.character_id === "lin_wan");

// 完整闸门（spec + 资产）
const full = validateCharacter(linWan, GLOBAL_VISUAL_CONFIG, [goodProbe("idle"), goodProbe("listening"), goodProbe("speaking"), goodProbe("tender"), goodProbe("caring")]);
ok("完整闸门（spec+资产）通过", full.passed === true);

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log("\n资产管线测试全部通过。");
