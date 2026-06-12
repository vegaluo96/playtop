/**
 * 外部盘口校准:把百度/足球财富/其它公开源样本导入本地,按时间对齐我方快照后比较。
 * 样本值使用 PlayTop 统一口径:ah/ou 为净水(0.90),eu 为十进制赔率(2.35)。
 */
import { db, tx } from "../db";
import { PRIMARY_BOOKMAKERS, type SnapRow } from "./store";

export type OddsMarket = "ah" | "ou" | "eu";
export type OddsFormat = "net" | "decimal";

export interface ExternalOddsInput {
  fixtureId?: number;
  fixture_id?: number;
  source: string;
  market: OddsMarket;
  line?: number | null;
  h?: number;
  a?: number;
  d?: number | null;
  home?: number;
  away?: number;
  draw?: number | null;
  capturedAt?: number | string;
  captured_at?: number | string;
  /** ah/ou 支持 decimal 输入(1.90)并自动转净水(0.90);eu 永远保留 decimal。 */
  format?: OddsFormat;
  url?: string;
  raw?: unknown;
}

export interface ExternalOddsSample {
  fixtureId: number;
  source: string;
  market: OddsMarket;
  line: number | null;
  h: number;
  a: number;
  d: number | null;
  capturedAt: number;
  raw: unknown;
}

export interface CalibrationRow {
  sample: ExternalOddsSample;
  local: SnapRow | null;
  status: "ok" | "warn" | "fail" | "missing";
  lineDelta: number | null;
  waterDelta: number | null;
  note: string;
}

export interface CalibrationOptions {
  /** 外部样本与本地快照允许的时间错位;默认 10min。 */
  skewMs?: number;
  /** ah/ou 净水差异阈值;默认 0.05。 */
  waterTolerance?: number;
  /** eu 十进制赔率差异阈值;默认 0.08。 */
  euTolerance?: number;
}

const lineEq = (a: number | null, b: number | null) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.001);
const round2 = (v: number) => Math.round(v * 100) / 100;

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

function asNum(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} 不是有效数字`);
  return n;
}

function normalizeWater(v: number, market: OddsMarket, format?: OddsFormat): number {
  if (market === "eu") return v;
  if (format === "decimal" || (!format && v > 1.2)) return round2(v - 1);
  return round2(v);
}

export function normalizeExternalOddsInput(input: ExternalOddsInput): ExternalOddsSample {
  const fixtureId = Number(input.fixtureId ?? input.fixture_id);
  if (!fixtureId) throw new Error("fixtureId 缺失");
  if (!input.source?.trim()) throw new Error("source 缺失");
  if (!["ah", "ou", "eu"].includes(input.market)) throw new Error(`market 无效:${String(input.market)}`);
  const market = input.market;
  const h0 = asNum(input.h ?? input.home, "h/home");
  const a0 = asNum(input.a ?? input.away, "a/away");
  const d0 = input.d ?? input.draw;
  return {
    fixtureId,
    source: input.source.trim(),
    market,
    line: market === "eu" ? null : input.line == null ? null : asNum(input.line, "line"),
    h: normalizeWater(h0, market, input.format),
    a: normalizeWater(a0, market, input.format),
    d: d0 == null ? null : normalizeWater(asNum(d0, "d/draw"), market, input.format),
    capturedAt: parseTime(input.capturedAt ?? input.captured_at),
    raw: input.raw ?? { ...input },
  };
}

export function importExternalOddsSamples(inputs: ExternalOddsInput[]): ExternalOddsSample[] {
  const samples = inputs.map(normalizeExternalOddsInput);
  tx(() => {
    const stmt = db().prepare(
      `INSERT OR REPLACE INTO odds_external_samples
       (fixture_id, source, market, line, h, a, d, captured_at, raw, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of samples) {
      stmt.run(s.fixtureId, s.source, s.market, s.line, s.h, s.a, s.d, s.capturedAt, JSON.stringify(s.raw), Date.now());
    }
  });
  return samples;
}

function rankBookmaker(n: string): number {
  const i = PRIMARY_BOOKMAKERS.indexOf(n);
  return i < 0 ? 99 : i;
}

export function localMainSnapshotAt(fixtureId: number, market: OddsMarket, at: number, skewMs = 10 * 60_000): SnapRow | null {
  const cutoff = at + skewMs;
  const rows = db()
    .prepare(
      `SELECT s.* FROM odds_snapshots s
       JOIN (
         SELECT bookmaker, MAX(captured_at) at
         FROM odds_snapshots
         WHERE fixture_id = ? AND market = ? AND captured_at <= ?
         GROUP BY bookmaker
       ) t ON s.bookmaker = t.bookmaker AND s.captured_at = t.at
       WHERE s.fixture_id = ? AND s.market = ?`,
    )
    .all(fixtureId, market, cutoff, fixtureId, market) as unknown as SnapRow[];
  if (rows.length === 0) return null;
  const candidates =
    market === "eu"
      ? rows
      : (() => {
          const lined = rows.filter((r) => r.line != null);
          if (lined.length === 0) return rows;
          const sorted = lined.map((r) => r.line as number).sort((a, b) => a - b);
          const consensus = sorted[Math.floor((sorted.length - 1) / 2)];
          return lined.filter((r) => r.line === consensus);
        })();
  return [...candidates].sort((x, y) => rankBookmaker(x.bookmaker) - rankBookmaker(y.bookmaker) || y.captured_at - x.captured_at)[0] ?? null;
}

export function compareExternalOdds(samples: ExternalOddsSample[], opts: CalibrationOptions = {}): CalibrationRow[] {
  const skewMs = opts.skewMs ?? 10 * 60_000;
  const waterTol = opts.waterTolerance ?? 0.05;
  const euTol = opts.euTolerance ?? 0.08;
  return samples.map((sample) => {
    const local = localMainSnapshotAt(sample.fixtureId, sample.market, sample.capturedAt, skewMs);
    if (!local) {
      return { sample, local, status: "missing", lineDelta: null, waterDelta: null, note: "本地没有对应市场快照" };
    }
    const lineDelta = sample.market === "eu" || sample.line == null || local.line == null ? null : round2(local.line - sample.line);
    const diffs = [Math.abs(local.h - sample.h), Math.abs(local.a - sample.a)];
    if (sample.market === "eu" && local.d != null && sample.d != null) diffs.push(Math.abs(local.d - sample.d));
    const waterDelta = round2(Math.max(...diffs));
    if (sample.market !== "eu" && !lineEq(local.line, sample.line)) {
      return { sample, local, status: "fail", lineDelta, waterDelta, note: `盘口线不一致:本地 ${local.line ?? "—"} vs 外部 ${sample.line ?? "—"}` };
    }
    const tol = sample.market === "eu" ? euTol : waterTol;
    if (waterDelta > tol) {
      return { sample, local, status: "warn", lineDelta, waterDelta, note: `同线但水位/赔率差 ${waterDelta.toFixed(2)} > ${tol.toFixed(2)}` };
    }
    return { sample, local, status: "ok", lineDelta, waterDelta, note: "对齐" };
  });
}

export function formatCalibrationReport(rows: CalibrationRow[]): string {
  const icon = { ok: "✓", warn: "△", fail: "✗", missing: "⊘" } as const;
  const counts = rows.reduce<Record<CalibrationRow["status"], number>>((acc, r) => {
    acc[r.status]++;
    return acc;
  }, { ok: 0, warn: 0, fail: 0, missing: 0 });
  const lines = [
    `■ 外部盘口校准 · 样本 ${rows.length} 条 · ✓${counts.ok} △${counts.warn} ✗${counts.fail} ⊘${counts.missing}`,
  ];
  for (const r of rows) {
    const s = r.sample;
    const local = r.local;
    const ext = s.market === "eu" ? `${s.h}/${s.d ?? "—"}/${s.a}` : `${s.line ?? "—"} ${s.h}/${s.a}`;
    const mine = !local ? "本地无" : s.market === "eu" ? `${local.h}/${local.d ?? "—"}/${local.a}` : `${local.line ?? "—"} ${local.h}/${local.a}`;
    lines.push(`  ${icon[r.status]} fixture=${s.fixtureId} ${s.market} · ${s.source} ${ext} ｜ PlayTop ${mine} · ${r.note}`);
  }
  return lines.join("\n");
}
