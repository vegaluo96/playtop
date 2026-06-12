/**
 * Public external technical-stats calibration CLI:
 *   npm run calibrate:stats-public -- docs/external-stats-samples-2026-06-12.json
 *
 * This script is intentionally read-only. It compares externally captured
 * score/stat samples with the public production /api/match/<fixtureId>?deep=1
 * payload and never imports local DB helpers or writes SQLite/KV.
 */
import { readFileSync } from "node:fs";

type Evidence = "full-match-centre" | "partial-article" | "live-report" | "search-snippet" | "manual-snapshot";
type Status = "ok" | "warn" | "fail" | "missing";
type SidePair = { home: number; away: number };

interface PublicStatsInput {
  fixtureId?: number;
  fixture_id?: number;
  match?: string;
  source: string;
  url?: string;
  capturedAt?: number | string;
  captured_at?: number | string;
  evidence?: Evidence;
  score?: unknown;
  stats?: Record<string, unknown>;
  note?: string;
}

interface SampleStat {
  label: string;
  canonical: string;
  pair: SidePair | null;
}

interface Sample {
  fixtureId: number;
  match: string;
  source: string;
  url: string | null;
  capturedAt: number;
  evidence: Evidence;
  score: SidePair | null;
  stats: SampleStat[];
  note: string;
}

interface PublicStat {
  label: string;
  canonical: string;
  pair: SidePair;
}

interface Row {
  sample: Sample;
  status: Status;
  note: string;
}

const ICON: Record<Status, string> = { ok: "✓", warn: "△", fail: "✗", missing: "⊘" };
const STAT_ALIASES: [string, string[]][] = [
  ["控球率", ["控球率", "possession", "ball possession", "possession %"]],
  ["预期进球 xG", ["预期进球", "预期进球 xG", "xg", "expected goals", "expected_goals"]],
  ["射门", ["射门", "总射门", "shots", "total shots"]],
  ["射正", ["射正", "射正数", "shots on target", "shots on goal"]],
  ["射偏", ["射偏", "shots off target", "shots off goal"]],
  ["被封堵", ["被封堵", "blocked shots", "shots blocked"]],
  ["禁区内射门", ["禁区内射门", "shots inside box", "shots insidebox"]],
  ["禁区外射门", ["禁区外射门", "shots outside box", "shots outsidebox"]],
  ["角球", ["角球", "corners", "corner kicks"]],
  ["越位", ["越位", "offsides", "offside"]],
  ["犯规", ["犯规", "fouls", "fouls committed"]],
  ["黄牌", ["黄牌", "yellow cards", "yellow card"]],
  ["红牌", ["红牌", "red cards", "red card"]],
  ["门将扑救", ["门将扑救", "goalkeeper saves", "saves"]],
  ["传球", ["传球", "passes", "total passes"]],
  ["传球成功", ["传球成功", "accurate passes", "passes accurate"]],
  ["传球成功率", ["传球成功率", "pass accuracy", "passes %", "passing accuracy"]],
];

function key(v: string) {
  return v.toLowerCase().replace(/[%_\-:/().]+/g, " ").replace(/\s+/g, " ").trim();
}

const ALIAS_TO_CANONICAL = new Map<string, string>(
  STAT_ALIASES.flatMap(([canonical, aliases]) => aliases.map((alias) => [key(alias), canonical] as const)),
);

function canonicalLabel(label: string) {
  return ALIAS_TO_CANONICAL.get(key(label)) ?? label.trim();
}

function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function parsePair(v: unknown, label: string): SidePair | null {
  if (typeof v === "string") {
    const parts = v.split(/\s*[-:]\s*/);
    if (parts.length !== 2) return null;
    const home = asNum(parts[0]);
    const away = asNum(parts[1]);
    return home == null || away == null ? null : { home, away };
  }
  if (Array.isArray(v)) {
    const home = asNum(v[0]);
    const away = asNum(v[1]);
    if (home == null || away == null) return null;
    return { home, away };
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const home = asNum(o.home ?? o.h ?? o.l ?? o.left);
    const away = asNum(o.away ?? o.a ?? o.r ?? o.right);
    if (home == null || away == null) return null;
    return { home, away };
  }
  return null;
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

function iso(t: number) {
  return new Date(t).toISOString();
}

function normalizeInput(input: PublicStatsInput): Sample {
  const fixtureId = Number(input.fixtureId ?? input.fixture_id);
  if (!fixtureId) throw new Error("fixtureId is required");
  if (!input.source?.trim()) throw new Error("source is required");
  const stats = Object.entries(input.stats ?? {}).map(([label, value]) => ({
    label,
    canonical: canonicalLabel(label),
    pair: parsePair(value, label),
  }));
  return {
    fixtureId,
    match: input.match?.trim() || String(fixtureId),
    source: input.source.trim(),
    url: input.url?.trim() || null,
    capturedAt: parseTime(input.capturedAt ?? input.captured_at),
    evidence: input.evidence ?? "partial-article",
    score: input.score == null ? null : parsePair(input.score, "score"),
    stats,
    note: input.note?.trim() || "",
  };
}

function parseSamples(path: string): Sample[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const raw = path.endsWith(".jsonl")
    ? text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as PublicStatsInput)
    : JSON.parse(text);
  const inputs = Array.isArray(raw) ? raw : [raw];
  return inputs.map((input) => normalizeInput(input as PublicStatsInput));
}

function publicStats(payload: Record<string, unknown>): PublicStat[] {
  const rows = Array.isArray((payload.tech as Record<string, unknown> | undefined)?.stats)
    ? ((payload.tech as Record<string, unknown>).stats as Record<string, unknown>[])
    : [];
  return rows
    .map((row) => {
      const label = String(row.label ?? "");
      const home = asNum(row.l ?? row.lv);
      const away = asNum(row.r ?? row.rv);
      return label && home != null && away != null
        ? { label, canonical: canonicalLabel(label), pair: { home, away } }
        : null;
    })
    .filter((row): row is PublicStat => row != null);
}

function publicScore(payload: Record<string, unknown>): SidePair | null {
  const score = (payload.header as Record<string, unknown> | undefined)?.score;
  return parsePair(score, "public score");
}

function tolerance(label: string): number {
  const k = key(label);
  if (k.includes("xg") || k.includes("expected")) return 0.05;
  if (k.includes("率") || k.includes("possession") || k.includes("accuracy") || k.includes("%")) return 1;
  return 0;
}

function pairText(pair: SidePair | null) {
  return pair ? `${pair.home}-${pair.away}` : "-";
}

function samePair(a: SidePair, b: SidePair, tol: number) {
  return Math.abs(a.home - b.home) <= tol && Math.abs(a.away - b.away) <= tol;
}

function compare(sample: Sample, payload: Record<string, unknown> | null): Row {
  if (!payload) return { sample, status: "missing", note: "production public API request failed or returned no payload" };
  const facts: string[] = [];
  const missing: string[] = [];
  const mismatches: string[] = [];
  let comparableStats = 0;
  let matchedStats = 0;

  if (sample.score) {
    const localScore = publicScore(payload);
    if (!localScore) missing.push("score");
    else if (samePair(sample.score, localScore, 0)) facts.push(`score ${pairText(sample.score)} ok`);
    else mismatches.push(`score external ${pairText(sample.score)} / ZSKY ${pairText(localScore)}`);
  }

  const localStats = new Map(publicStats(payload).map((row) => [row.canonical, row]));
  for (const stat of sample.stats) {
    if (!stat.pair) {
      missing.push(`${stat.label} non-numeric`);
      continue;
    }
    const local = localStats.get(stat.canonical);
    if (!local) {
      missing.push(stat.label);
      continue;
    }
    comparableStats++;
    const tol = tolerance(stat.canonical);
    if (samePair(stat.pair, local.pair, tol)) matchedStats++;
    else mismatches.push(`${stat.label} external ${pairText(stat.pair)} / ZSKY ${pairText(local.pair)}`);
  }

  if (comparableStats > 0) facts.push(`stats matched ${matchedStats}/${comparableStats}`);
  if (mismatches.length > 0) {
    const bits = [...facts, ...mismatches.slice(0, 4)];
    if (sample.evidence !== "full-match-centre") {
      bits.push("partial external evidence has a numeric mismatch; kept as WARN, not FAIL");
      if (sample.note) bits.push(sample.note);
      return { sample, status: "warn", note: bits.join("; ") };
    }
    return { sample, status: "fail", note: bits.join("; ") };
  }
  if (sample.evidence !== "full-match-centre") {
    const bits = [...facts];
    if (comparableStats === 0) bits.push("no comparable full technical stat table captured");
    if (missing.length > 0) bits.push(`not compared: ${missing.slice(0, 4).join(", ")}`);
    bits.push("partial external evidence; kept as WARN, not PASS");
    if (sample.note) bits.push(sample.note);
    return { sample, status: "warn", note: bits.join("; ") };
  }
  if (missing.length > 0) {
    return { sample, status: "missing", note: `full-match-centre sample has missing comparisons: ${missing.slice(0, 6).join(", ")}` };
  }
  if (sample.stats.length === 0 && !sample.score) {
    return { sample, status: "missing", note: "sample has neither score nor comparable stats" };
  }
  return { sample, status: "ok", note: facts.join("; ") || "full match-centre sample aligned" };
}

async function fetchMatch(base: string, fixtureId: number): Promise<Record<string, unknown>> {
  const url = `${base.replace(/\/+$/, "")}/api/match/${fixtureId}?tz=UTC%2B8&deep=1`;
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
    console.error("Usage: npm run calibrate:stats-public -- samples.json [--base https://zsky.com]");
    process.exit(1);
  }
  const base = argValue(args, "--base", process.env.PUBLIC_CALIBRATE_BASE || "https://zsky.com");
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
      rows.push(compare(sample, payload));
    } catch (e) {
      rows.push({
        sample,
        status: "missing",
        note: `production public API request failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const counts = rows.reduce<Record<Status, number>>((acc, row) => {
    acc[row.status]++;
    return acc;
  }, { ok: 0, warn: 0, fail: 0, missing: 0 });
  console.log(`■ Public external stats calibration · samples ${rows.length} · ✓${counts.ok} △${counts.warn} ✗${counts.fail} ⊘${counts.missing}`);
  for (const row of rows) {
    const s = row.sample;
    console.log(`  ${ICON[row.status]} fixture=${s.fixtureId} ${s.match} · ${s.source} · ${s.evidence} @ ${iso(s.capturedAt)} · ${row.note}`);
  }
  if (counts.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
