/**
 * AI 报告(真模型):同场生成一次全员复用;指数指纹变化才重生成;
 * tokens 达日预算 80% 告警、100% 降级模板;失败回落模板。
 * 硬约束:提示词禁止模型新增任何数字,只能复述给定事实。
 */
import { createHash } from "node:crypto";
import { db } from "../db";
import { cfgLlmDailyBudget, cfgLlmKey, cfgLlmModel } from "../platform/config";
import type { Panorama } from "../af/panorama";
import type { ReportSection } from "../views/report";
import { chatComplete } from "./client";

const day8 = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
export const REPORT_FACTS_VERSION = "report-facts:v2:pre-kickoff-quant-signals";

function usageRow(): { tokens: number; count: number; hits: number; fails: number } {
  const d = db();
  d.prepare("INSERT OR IGNORE INTO llm_usage (date) VALUES (?)").run(day8());
  return d.prepare("SELECT tokens, count, hits, fails FROM llm_usage WHERE date = ?").get(day8()) as unknown as {
    tokens: number; count: number; hits: number; fails: number;
  };
}
function bumpUsage(field: "tokens" | "count" | "hits" | "fails", n = 1): void {
  db().prepare(`UPDATE llm_usage SET ${field} = ${field} + ? WHERE date = ?`).run(n, day8());
}

export function llmStats(): { configured: boolean; model: string; budget: number; tokens: number; count: number; hits: number; fails: number } {
  const u = usageRow();
  return { configured: !!cfgLlmKey(), model: cfgLlmModel(), budget: cfgLlmDailyBudget(), ...u };
}

function fingerprintOf(p: Panorama, templateSecs?: ReportSection[]): string {
  const last = (s: { line: number | null; h: number; a: number }[]) => {
    const r = s[s.length - 1];
    return r ? [r.line, r.h, r.a] : null;
  };
  return createHash("sha1")
    .update(
      JSON.stringify([
        REPORT_FACTS_VERSION,
        last(p.odds.ah as never),
        last(p.odds.ou as never),
        p.bundle?.lineups ? (p.bundle.lineups as unknown[]).length : 0,
        p.injuries.length,
        p.fixture.status,
        templateSecs?.map((s) => [s.h, s.ps]) ?? null,
      ]),
    )
    .digest("hex");
}

/** 开赛即锁定:状态离开未开赛族后不再生成新版,报告固化为临场版 */
export function reportLocked(status: string): boolean {
  return !["NS", "TBD", "PST"].includes(status);
}

/**
 * worker 预生成判定:T-24h 内、未开赛、预算 <80%、距上版 ≥30min、有需求
 * (免费场/已有人解锁/临场 2h 内)。指纹未变时 getLlmReport 自然命中缓存不耗 token。
 */
export function shouldPregenReport(fid: number, kickoffUtcMs: number, status: string, now = Date.now()): boolean {
  if (!cfgLlmKey() || reportLocked(status)) return false;
  const toKick = kickoffUtcMs - now;
  if (toKick > 24 * 3_600_000 || toKick <= 0) return false;
  const u = usageRow();
  if (u.tokens >= cfgLlmDailyBudget() * 0.8) return false;
  const d = db();
  const lastGen = (d.prepare("SELECT MAX(gen_at) g FROM report_versions WHERE fixture_id = ?").get(fid) as { g: number | null } | undefined)?.g ?? 0;
  if (now - lastGen < 30 * 60_000) return false;
  const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const isFree = !!d.prepare("SELECT 1 FROM free_fixtures WHERE date = ? AND fixture_id = ?").get(today, fid);
  const hasUnlock = !!d.prepare("SELECT 1 FROM unlocks WHERE fixture_id = ? LIMIT 1").get(fid);
  return isFree || hasUnlock || toKick <= 2 * 3_600_000;
}

export interface ReportVersionMeta {
  ver: number;
  gen_at: number;
  changed: string[];
}

export function listReportVersions(fid: number): ReportVersionMeta[] {
  const rows = db()
    .prepare("SELECT ver, gen_at, changed FROM report_versions WHERE fixture_id = ? ORDER BY ver")
    .all(fid) as unknown as { ver: number; gen_at: number; changed: string }[];
  return rows.map((r) => ({ ver: r.ver, gen_at: r.gen_at, changed: JSON.parse(r.changed || "[]") as string[] }));
}

export function getReportVersion(fid: number, ver: number): { sections: ReportSection[]; model: string; gen_at: number } | null {
  const r = db().prepare("SELECT content, model, gen_at FROM report_versions WHERE fixture_id = ? AND ver = ?").get(fid, ver) as
    | { content: string; model: string; gen_at: number }
    | undefined;
  if (!r) return null;
  try {
    return { sections: JSON.parse(r.content) as ReportSection[], model: r.model, gen_at: r.gen_at };
  } catch {
    return null;
  }
}

/** 段落级差异:与上一版逐 section 比 sha1,返回变化的分区标题(版本切换器「本版更新」徽标) */
function sectionDiff(prev: ReportSection[] | null, next: ReportSection[]): string[] {
  if (!prev) return [];
  const hash = (s: ReportSection) => createHash("sha1").update(JSON.stringify(s.ps)).digest("hex");
  const prevMap = new Map(prev.map((s) => [s.h, hash(s)]));
  return next.filter((s) => prevMap.get(s.h) !== hash(s)).map((s) => s.h);
}

function appendVersion(fid: number, fp: string, sections: ReportSection[], model: string, tokens: number): void {
  const d = db();
  const lastV = d.prepare("SELECT ver, content FROM report_versions WHERE fixture_id = ? ORDER BY ver DESC LIMIT 1").get(fid) as
    | { ver: number; content: string }
    | undefined;
  let changed: string[] = [];
  try {
    changed = sectionDiff(lastV ? (JSON.parse(lastV.content) as ReportSection[]) : null, sections);
  } catch {
    /* 上版损坏按首版处理 */
  }
  d.prepare(
    "INSERT OR IGNORE INTO report_versions (fixture_id, ver, fingerprint, content, model, tokens, gen_at, changed) VALUES (?,?,?,?,?,?,?,?)",
  ).run(fid, (lastV?.ver ?? 0) + 1, fp, JSON.stringify(sections), model, tokens, Date.now(), JSON.stringify(changed));
}

/**
 * 取本场 LLM 报告(命中缓存→复用;未配置/超预算/失败→null,调用方用模板)。
 */
export async function getLlmReport(p: Panorama, templateSecs: ReportSection[]): Promise<{ sections: ReportSection[]; by: string } | null> {
  if (!cfgLlmKey()) return null;
  const d = db();
  const fid = p.fixture.fixture_id;
  const fp = fingerprintOf(p, templateSecs);
  const cached = d.prepare("SELECT fingerprint, content, model FROM report_cache WHERE fixture_id = ?").get(fid) as
    | { fingerprint: string; content: string; model: string }
    | undefined;
  const locked = reportLocked(p.fixture.status);
  // 开赛锁定:有缓存即固化复用,指纹变化也不再生成;无缓存/缓存损坏则回落模板,绝不赛中补生成。
  if (locked) {
    if (!cached || cached.fingerprint !== fp) return null;
    try {
      bumpUsage("hits");
      return { sections: JSON.parse(cached.content) as ReportSection[], by: cached.model || "llm" };
    } catch {
      return null;
    }
  }
  if (cached && cached.fingerprint === fp) {
    try {
      bumpUsage("hits");
      return { sections: JSON.parse(cached.content) as ReportSection[], by: cached.model || "llm" };
    } catch {
      /* 缓存损坏则重生成 */
    }
  }
  const u = usageRow();
  if (u.tokens >= cfgLlmDailyBudget()) return null; // 100% 降级模板

  const facts = templateSecs.map((s) => `【${s.h}】\n${s.ps.join("\n")}`).join("\n\n");
  const system =
    "你是足球指数行情终端的资深分析师。把给定的事实改写为流畅、专业、紧凑的中文分析报告。" +
    "硬性约束:1) 只能使用给定事实中出现过的数字与指数,严禁新增、推算或修改任何数字;" +
    "2) 输出 JSON 数组,恰好 5 个对象,字段 h(分区标题,沿用给定五个标题)与 ps(段落字符串数组,每段 1-3 句);" +
    "3) 不输出 JSON 以外的任何内容。";
  const user = `比赛:${p.fixture.home_name} vs ${p.fixture.away_name}\n\n事实材料:\n${facts}`;
  try {
    const r = await chatComplete(system, user);
    const text = r.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(text) as ReportSection[];
    if (!Array.isArray(parsed) || parsed.length !== 5 || parsed.some((s) => !s.h || !Array.isArray(s.ps))) throw new Error("结构不符");
    d.prepare(
      "INSERT INTO report_cache (fixture_id, fingerprint, content, model, tokens, gen_at) VALUES (?,?,?,?,?,?) ON CONFLICT(fixture_id) DO UPDATE SET fingerprint=excluded.fingerprint, content=excluded.content, model=excluded.model, tokens=excluded.tokens, gen_at=excluded.gen_at",
    ).run(fid, fp, JSON.stringify(parsed), cfgLlmModel(), r.tokens, Date.now());
    appendVersion(fid, fp, parsed, cfgLlmModel(), r.tokens); // 版本历史:每次真实生成追加一版
    bumpUsage("tokens", r.tokens);
    bumpUsage("count");
    return { sections: parsed, by: cfgLlmModel() };
  } catch {
    bumpUsage("fails");
    return null; // 失败回落模板
  }
}
