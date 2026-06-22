#!/usr/bin/env -S npx tsx
// 资产管线 CLI：validate / export / prompts / new。
//
// 用法：
//   micall-assets validate <char.json> [--probes <probes.json>]
//   micall-assets export   <dir>       [-o micall_characters.json]
//   micall-assets prompts  <char.json> [--state <state>]
//   micall-assets new      <character_id> [--name <名字>]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GLOBAL_DEFAULTS, GLOBAL_VISUAL_CONFIG } from "./globalConfig.ts";
import { parseCharacter, importCharacter, exportCharacters } from "./bundle.ts";
import { validateCharacter } from "./validate.ts";
import { buildMasterPrompt, buildAllVideoPrompts } from "./prompts.ts";
import type { CharacterSpec, ClipProbe, ValidationReport } from "./schema.ts";

function loadSpec(path: string): CharacterSpec {
  return parseCharacter(readFileSync(path, "utf8"));
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function printReport(r: ValidationReport): void {
  const icon = r.passed ? "✓ PASS" : "✗ FAIL";
  console.log(`${icon}  ${r.character_id}`);
  for (const it of r.issues) {
    const mark = it.level === "error" ? "  ✗" : "  ·";
    console.log(`${mark} [${it.gate}] ${it.message}`);
  }
  if (!r.issues.length) console.log("  （无问题）");
}

function cmdValidate(args: string[]): number {
  const file = args[0];
  if (!file) return usage();
  const spec = loadSpec(file);
  const probesPath = flag(args, "--probes");
  const probes: ClipProbe[] | undefined = probesPath ? JSON.parse(readFileSync(probesPath, "utf8")) : undefined;
  const report = validateCharacter(spec, GLOBAL_VISUAL_CONFIG, probes);
  printReport(report);
  return report.passed ? 0 : 1;
}

function cmdExport(args: string[]): number {
  const dir = args[0];
  if (!dir) return usage();
  const out = flag(args, "-o") || "micall_characters.json";
  const specs = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadSpec(join(dir, f)));
  const bundle = exportCharacters(specs, GLOBAL_DEFAULTS);
  writeFileSync(out, JSON.stringify(bundle, null, 2), "utf8");
  const pass = bundle.characters.filter((c) => c.report.passed).length;
  console.log(`已导出 ${specs.length} 个角色 → ${out}（${pass} 通过 / ${specs.length - pass} 标红）`);
  return 0;
}

function cmdPrompts(args: string[]): number {
  const file = args[0];
  if (!file) return usage();
  const spec = loadSpec(file);
  const state = flag(args, "--state");
  console.log("═══ master_prompt（基准图，锚）═══\n" + buildMasterPrompt(spec, GLOBAL_VISUAL_CONFIG) + "\n");
  const vids = buildAllVideoPrompts(spec, GLOBAL_VISUAL_CONFIG);
  for (const [k, v] of Object.entries(vids)) {
    if (state && k !== state) continue;
    console.log(`═══ video_prompt[${k}] ═══\n${v}\n`);
  }
  return 0;
}

function cmdNew(args: string[]): number {
  const id = args[0];
  if (!id) return usage();
  const name = flag(args, "--name") || id;
  const scaffold: CharacterSpec = {
    identity: { character_id: id, name, version: "1.0.0", tagline: "", gender: "", age: 0, appearance: "", nationality: "", profile: { height_cm: 0, weight_kg: 0, birthday: "", race: "" } },
    persona: { core_traits: [], speaking_style: "", values_and_boundaries: "（必填：去讨好的依据）", background_story: "", hidden_layer: "（必填：未言明的冰山）", likes: [], dislikes: [] },
    visual: { master_prompt: { subject: "", inherit: "global_visual_config" }, master_frame_url: "", loops_spec: { idle: { micro_motion: "", count: 2 }, listening: { micro_motion: "", count: 1 }, speaking: { micro_motion: "", count: 1 } }, loops_url: {}, common_constraints: "所有视频以 master_frame 为首帧；首尾回到基准；固定机位；动作不规则" },
    voice: { provider: "minimax", voice_brief: "", reference_audio_url: "", minimax_params: { model: "speech-02-turbo", default_emotion: "neutral" }, voice_id: "", emotion_map: { idle: "neutral", listening: "neutral", speaking: "neutral" } },
    meta: { created_at: new Date().toISOString(), updated_at: "", seedance_version: "2.0", validation: { passed: false, report: "" }, checksum: "" },
  };
  const { spec } = importCharacter(scaffold, GLOBAL_DEFAULTS);
  console.log(JSON.stringify(spec, null, 2));
  return 0;
}

function usage(): number {
  console.log(`micall-assets <command>
  validate <char.json> [--probes <probes.json>]   跑导入校验闸门
  export   <dir>       [-o micall_characters.json] 导出全部角色
  prompts  <char.json> [--state <state>]           派生 master/video prompt
  new      <character_id> [--name <名字>]           脚手架一个新角色 spec`);
  return 2;
}

const [cmd, ...rest] = process.argv.slice(2);
const table: Record<string, (a: string[]) => number> = {
  validate: cmdValidate,
  export: cmdExport,
  prompts: cmdPrompts,
  new: cmdNew,
};
process.exit((table[cmd] || usage)(rest));
