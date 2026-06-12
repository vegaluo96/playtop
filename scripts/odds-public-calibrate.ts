/**
 * Public external odds calibration CLI:
 *   npm run calibrate:public -- docs/external-odds-samples-2026-06-12.json
 *
 * This script is intentionally read-only. It compares an external sample file
 * against the public production API at /api/match/<fixtureId> and never imports
 * local DB helpers or writes to SQLite/KV.
 */
import { readFileSync } from "node:fs";

type Market = "ah" | "ou" | "eu" | "live-ah" | "live-ou" | "live-eu";
type OddsFormat = "net" | "decimal";
type Evidence = "same-line-time" | "article-odds" | "search-snippet" | "tip-market" | "partial-market" | "market-existence";
type Status = "ok" | "warn" | "fail" | "missing";

interface PublicOddsInput {
  fixtureId?: number;
  fixture_id?: number;
  match?: string;
  source: string;
  url?: string;
  capturedAt?: number | string;
  captured_at?: number | string;
  market: Market;
  line?: number | null;
  h?: number | null;
  home?: number | null;
  d?: number | null;
  draw?: number | null;
  a?: number | null;
  away?: number | null;
  format?: OddsFormat;
  evidence?: Evidence;
  note?: string;
}

interface Sample {
  fixtureId: number;
  match: string;
  source: string;
  url: string | null;
  capturedAt: number;
  market: Market;
  line: number | null;
  h: number | null;
  d: number | null;
  a: number | null;
  evidence: Evidence;
  note: string;
}

interface LocalOdds {
  line: number | null;
  h: number | null;
  d: number | null;
  a: number | null;
  oddsAt: number | null;
}

interface Row {
  sample: Sample;
  local: LocalOdds | null;
  status: Status;
  lineDelta: number | null;
  valueDelta: number | null;
  note: string;
}

const ICON: Record<Status, string> = { ok: "✓", warn: "△", fail: "✗", missing: "⊘" };
const LINE_TEXT: Record<string, number> = {
  "平手": 0,
  "平半": 0.25,
  "半球": 0.5,
  "半一": 0.75,
  "一球": 1,
  "一/球半": 1.25,
  "球半": 1.5,
  "球半/两": 1.75,
  "两球": 2,
  "两/两半": 2.25,
  "两球半": 2.5,
  "两球半/三": 2.75,
  "三球": 3,
  "三/三半": 3.25,
  "三球半": 3.5,
  "三球半/四": 3.75,
  "四球": 4,
};

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

function asNum(v: unknown, label: string): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} is not a valid number`);
  return n;
}

function parseTime(v: number | string | undefined): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 10_000) return n;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function iso(t: number | null) {
  return t ? new Date(t).toISOString() : "unknown";
}

function normalizePrice(v: number | null, market: Market, format?: OddsFormat): number | null {
  if (v == null) return null;
  if (market.endsWith("eu")) return round2(v);
  if (format === "decimal" || (!format && v > 1.2)) return round2(v - 1);
  return round2(v);
}

function normalizeInput(input: PublicOddsInput): Sample {
  const fixtureId = Number(input.fixtureId ?? input.fixture_id);
  if (!fixtureId) throw new Error("fixtureId is required");
  if (!input.source?.trim()) throw new Error("source is required");
  if (!["ah", "ou", "eu", "live-ah", "live-ou", "live-eu"].includes(input.market)) throw new Error(`unsupported market: ${input.market}`);
  const h0 = asNum(input.h ?? input.home, "h/home");
  const d0 = asNum(input.d ?? input.draw, "d/draw");
  const a0 = asNum(input.a ?? input.away, "a/away");
  if (h0 == null && d0 == null && a0 == null) throw new Error(`sample for fixture ${fixtureId} has no h/d/a value`);
  return {
    fixtureId,
    match: input.match?.trim() || String(fixtureId),
    source: input.source.trim(),
    url: input.url?.trim() || null,
    capturedAt: parseTime(input.capturedAt ?? input.captured_at),
    market: input.market,
    line: input.market.endsWith("eu") ? null : asNum(input.line, "line"),
    h: normalizePrice(h0, input.market, input.format),
    d: normalizePrice(d0, input.market, input.format),
    a: normalizePrice(a0, input.market, input.format),
    evidence: input.evidence ?? "article-odds",
    note: input.note?.trim() || "",
  };
}

function parseSamples(path: string): Sample[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const raw = path.endsWith(".jsonl")
    ? text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as PublicOddsInput)
    : JSON.parse(text);
  const inputs = Array.isArray(raw) ? raw : [raw];
  return inputs.map((input) => normalizeInput(input as PublicOddsInput));
}

function parseLineText(text: unknown): number | null {
  const key = String(text ?? "").replace(/\s+/g, "");
  return Object.prototype.hasOwnProperty.call(LINE_TEXT, key) ? LINE_TEXT[key] : null;
}

function parseW(w: unknown, market: "ah" | "ou" | "eu"): Pick<LocalOdds, "h" | "d" | "a"> {
  const xs = String(w ?? "").split("/").map((x) => asNum(x, "ZSKY price"));
  if (market === "eu") return { h: xs[0] ?? null, d: xs[1] ?? null, a: xs[2] ?? null };
  return { h: xs[0] ?? null, d: null, a: xs[1] ?? null };
}

function localOdds(payload: Record<string, unknown>, market: Market): LocalOdds | null {
  const live = market.startsWith("live-");
  const baseMarket = market.replace("live-", "") as "ah" | "ou" | "eu";
  const summary = payload.summary as Record<string, unknown> | undefined;
  const source = live
    ? (((payload.liveOdds as Record<string, unknown> | null | undefined) ?? {})[baseMarket] as Record<string, unknown> | undefined)
    : (summary?.[baseMarket] as Record<string, unknown> | undefined);
  if (!source) return null;
  return {
    line: baseMarket === "eu" ? null : parseLineText(source.text),
    ...parseW(source.w, baseMarket),
    oddsAt: typeof summary?.oddsAt === "number" ? summary.oddsAt : null,
  };
}

function externalText(s: Sample) {
  if (s.market.endsWith("eu")) return `${s.h ?? "-"} / ${s.d ?? "-"} / ${s.a ?? "-"}`;
  return `${s.line ?? "-"} ${s.h ?? "-"} / ${s.a ?? "-"}`;
}

function localText(s: Sample, l: LocalOdds | null) {
  if (!l) return "no public market";
  if (s.market.endsWith("eu")) return `${l.h ?? "-"} / ${l.d ?? "-"} / ${l.a ?? "-"}`;
  return `${l.line ?? "-"} ${l.h ?? "-"} / ${l.a ?? "-"}`;
}

function compare(sample: Sample, local: LocalOdds | null, waterTol: number, euTol: number): Row {
  if (!local) {
    return { sample, local, status: "missing", lineDelta: null, valueDelta: null, note: "production public API has no comparable market" };
  }
  const strict = sample.evidence === "same-line-time";
  const lineDelta =
    sample.market.endsWith("eu") || sample.line == null || local.line == null ? null : round2(local.line - sample.line);
  const lineMismatch = !sample.market.endsWith("eu") && sample.line != null && local.line != null && Math.abs(local.line - sample.line) > 0.001;
  const deltas = [
    sample.h == null || local.h == null ? null : Math.abs(local.h - sample.h),
    sample.d == null || local.d == null ? null : Math.abs(local.d - sample.d),
    sample.a == null || local.a == null ? null : Math.abs(local.a - sample.a),
  ].filter((v): v is number => v != null);
  const valueDelta = deltas.length ? round2(Math.max(...deltas)) : null;
  const tol = sample.market.endsWith("eu") ? euTol : waterTol;
  if (!strict) {
    const bits = ["external evidence is not same-line/same-time; kept as WARN/OPEN, not PASS"];
    if (lineMismatch) bits.push(`line differs by ${lineDelta}`);
    if (valueDelta != null) bits.push(`max value delta ${valueDelta.toFixed(2)}`);
    if (sample.note) bits.push(sample.note);
    return { sample, local, status: "warn", lineDelta, valueDelta, note: bits.join("; ") };
  }
  if (lineMismatch) return { sample, local, status: "fail", lineDelta, valueDelta, note: `line mismatch: ZSKY ${local.line} vs external ${sample.line}` };
  if (valueDelta != null && valueDelta > tol) {
    return { sample, local, status: "warn", lineDelta, valueDelta, note: `same-line value delta ${valueDelta.toFixed(2)} > ${tol.toFixed(2)}` };
  }
  return { sample, local, status: "ok", lineDelta, valueDelta, note: "aligned on same-line/same-time evidence" };
}

async function fetchMatch(base: string, fixtureId: number): Promise<Record<string, unknown>> {
  const url = `${base.replace(/\/+$/, "")}/api/match/${fixtureId}?tz=UTC%2B8`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) throw new Error(`API returned ok=${String(json.ok)}`);
  return json;
}

function argValue(args: string[], name: string, fallback: string) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run calibrate:public -- samples.json [--base https://zsky.com] [--water 0.05] [--eu 0.08]");
    process.exit(1);
  }
  const base = argValue(args, "--base", process.env.PUBLIC_CALIBRATE_BASE || "https://zsky.com");
  const waterTol = Number(argValue(args, "--water", "0.05"));
  const euTol = Number(argValue(args, "--eu", "0.08"));
  const samples = parseSamples(file);
  const cache = new Map<number, Record<string, unknown>>();
  const rows: Row[] = [];
  for (const sample of samples) {
    try {
      let payload = cache.get(sample.fixtureId);
      if (!payload) {
        payload = await fetchMatch(base, sample.fixtureId);
        cache.set(sample.fixtureId, payload);
      }
      rows.push(compare(sample, localOdds(payload, sample.market), waterTol, euTol));
    } catch (e) {
      rows.push({
        sample,
        local: null,
        status: "missing",
        lineDelta: null,
        valueDelta: null,
        note: `production public API request failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const counts = rows.reduce<Record<Status, number>>((acc, row) => {
    acc[row.status]++;
    return acc;
  }, { ok: 0, warn: 0, fail: 0, missing: 0 });
  console.log(`■ Public external odds calibration · samples ${rows.length} · ✓${counts.ok} △${counts.warn} ✗${counts.fail} ⊘${counts.missing}`);
  for (const row of rows) {
    const s = row.sample;
    console.log(
      `  ${ICON[row.status]} fixture=${s.fixtureId} ${s.market} ${s.match} · ${s.source} ${externalText(s)} @ ${iso(s.capturedAt)} | ZSKY ${localText(s, row.local)} @ ${iso(row.local?.oddsAt ?? null)} · ${row.note}`,
    );
  }
  if (counts.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
