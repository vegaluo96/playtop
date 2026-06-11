/**
 * AI 报告(真模型):同场生成一次全员复用;盘口指纹变化才重生成;
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

function fingerprintOf(p: Panorama): string {
  const last = (s: { line: number | null; h: number; a: number }[]) => {
    const r = s[s.length - 1];
    return r ? [r.line, r.h, r.a] : null;
  };
  return createHash("sha1")
    .update(
      JSON.stringify([
        last(p.odds.ah as never),
        last(p.odds.ou as never),
        p.bundle?.lineups ? (p.bundle.lineups as unknown[]).length : 0,
        p.injuries.length,
        p.fixture.status,
      ]),
    )
    .digest("hex");
}

/**
 * 取本场 LLM 报告(命中缓存→复用;未配置/超预算/失败→null,调用方用模板)。
 */
export async function getLlmReport(p: Panorama, templateSecs: ReportSection[]): Promise<{ sections: ReportSection[]; by: string } | null> {
  if (!cfgLlmKey()) return null;
  const d = db();
  const fid = p.fixture.fixture_id;
  const fp = fingerprintOf(p);
  const cached = d.prepare("SELECT fingerprint, content, model FROM report_cache WHERE fixture_id = ?").get(fid) as
    | { fingerprint: string; content: string; model: string }
    | undefined;
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
    "你是足球盘口分析终端的资深分析师。把给定的事实改写为流畅、专业、紧凑的中文分析报告。" +
    "硬性约束:1) 只能使用给定事实中出现过的数字与盘口,严禁新增、推算或修改任何数字;" +
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
    bumpUsage("tokens", r.tokens);
    bumpUsage("count");
    return { sections: parsed, by: cfgLlmModel() };
  } catch {
    bumpUsage("fails");
    return null; // 失败回落模板
  }
}
