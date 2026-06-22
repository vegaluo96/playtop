// 资产包导入 / 导出（docs/01 §7，docs/02 §7「角色导入/导出」）。
//
// 「spec 即本体、资产即编译产物」：导出整份 spec（含产物 url 缓存 + 校验报告）即可移植、
// 可备份、可跨环境重建；供大模型读取后再生成音色与表情资产。
import { createHash } from "node:crypto";
import type {
  CharacterSpec,
  ClipProbe,
  GlobalDefaults,
  GlobalVisualConfig,
  ValidationReport,
} from "./schema.ts";
import { validateCharacter } from "./validate.ts";

/** 稳定校验和：对规范化后的 spec（剔除 meta.checksum 自身）做 sha256，用于迁移完整性。 */
export function checksum(spec: CharacterSpec): string {
  const clone: CharacterSpec = JSON.parse(JSON.stringify(spec));
  clone.meta = { ...clone.meta, checksum: "", validation: { passed: false, report: "" } };
  return "sha256:" + createHash("sha256").update(canonical(clone)).digest("hex").slice(0, 32);
}

// 稳定序列化：按 key 排序，保证同一 spec 始终得到同一 checksum。
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as any)[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** 解析并粗校形状（不做闸门校验）。 */
export function parseCharacter(json: string): CharacterSpec {
  const spec = JSON.parse(json) as CharacterSpec;
  if (!spec?.identity?.character_id) throw new Error("不是合法的角色 spec：缺少 identity.character_id");
  return spec;
}

export interface ImportResult {
  spec: CharacterSpec;
  report: ValidationReport;
}

/**
 * 导入：跑校验闸门，把结果写回 meta（validation / checksum / updated_at）。
 * passed=false 时调用方应拒绝入库（标红）。
 */
export function importCharacter(
  spec: CharacterSpec,
  g: GlobalDefaults,
  probes?: ClipProbe[],
): ImportResult {
  const report = validateCharacter(spec, g.visual, probes);
  const next: CharacterSpec = {
    ...spec,
    meta: {
      ...spec.meta,
      updated_at: report.checked_at,
      validation: {
        passed: report.passed,
        report: summarize(report),
      },
      checksum: "",
    },
  };
  next.meta.checksum = checksum(next);
  return { spec: next, report };
}

function summarize(r: ValidationReport): string {
  const e = r.issues.filter((i) => i.level === "error").length;
  const w = r.issues.filter((i) => i.level === "warn").length;
  return `${r.passed ? "PASS" : "FAIL"} · ${e} error / ${w} warn @ ${r.checked_at}`;
}

// ─────────────────────────── 导出 micall_characters.json ───────────────────────────
export interface CharacterBundleExport {
  $schema_version: "1.0";
  generated_at: string;
  global_visual_config: GlobalVisualConfig;
  global_defaults: Omit<GlobalDefaults, "visual">;
  characters: ImportResult[];
}

/** 导出全部角色（含校验报告）。背景/全局配置一并带出，确保跨环境可重建。 */
export function exportCharacters(specs: CharacterSpec[], g: GlobalDefaults, probesByChar?: Record<string, ClipProbe[]>): CharacterBundleExport {
  const { visual, ...defaults } = g;
  return {
    $schema_version: "1.0",
    generated_at: new Date().toISOString(),
    global_visual_config: visual,
    global_defaults: defaults,
    characters: specs.map((s) => importCharacter(s, g, probesByChar?.[s.identity.character_id])),
  };
}
