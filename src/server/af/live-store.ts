/**
 * 滚球帧归档:/odds/live(无书商维度)→ live_odds_snapshots + 滚球异动。
 * 写入纪律:仅变化帧落库(line/水位/封盘态任一变化),无变化时每 5min 一帧心跳;
 * 异动:封盘帧不参与判定,同场同市场 60s 冷却(防进球瞬间盘口翻飞刷屏)。
 */
import { db } from "../db";
import { detectMovement, type LiveMarketFrame } from "./normalize";
import { isDisplayableLiveEuTriplet } from "./odds-quality";

const HEARTBEAT_MS = 5 * 60_000;
const MOVE_COOLDOWN_MS = 60_000;
const EU_MOVE_MIN = 0.1; // 滚球胜平负:主胜赔 |Δ|≥0.10 记水位异动

export interface LiveSnapRow {
  line: number | null;
  h: number;
  a: number;
  d: number | null;
  suspended: number;
  captured_at: number;
}

export type LiveOddsMarket = "ah" | "ou" | "eu";

function lastRow(fixtureId: number, market: string): LiveSnapRow | null {
  return (
    (db()
      .prepare(
        "SELECT line, h, a, d, suspended, captured_at FROM live_odds_snapshots WHERE fixture_id=? AND market=? ORDER BY captured_at DESC LIMIT 1",
      )
      .get(fixtureId, market) as LiveSnapRow | undefined) ?? null
  );
}

function lastMoveAt(fixtureId: number, market: string): number {
  const r = db()
    .prepare("SELECT t1 FROM movements WHERE fixture_id=? AND market=? AND phase='滚球' ORDER BY t1 DESC LIMIT 1")
    .get(fixtureId, market) as { t1: number } | undefined;
  return r?.t1 ?? 0;
}

const same = (p: LiveSnapRow, f: LiveMarketFrame) =>
  p.line === f.line && p.h === f.h && p.a === f.a && (p.d ?? null) === (f.d ?? null) && !!p.suspended === f.suspended;

/** 归档一场滚球帧;返回写入的异动条数 */
export function archiveLiveOdds(fixtureId: number, frames: LiveMarketFrame[], capturedAt = Date.now()): number {
  const d = db();
  let moves = 0;
  for (const f of frames) {
    const prev = lastRow(fixtureId, f.market);
    const changed = !prev || !same(prev, f);
    if (!changed && capturedAt - prev!.captured_at < HEARTBEAT_MS) continue;
    d.prepare(
      "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(fixtureId, f.market, f.line, f.h, f.a, f.d, f.suspended ? 1 : 0, capturedAt);

    // 异动:前后帧都在售才判定;冷却期内不重复记
    if (!prev || !changed || prev.suspended || f.suspended) continue;
    if (capturedAt - lastMoveAt(fixtureId, f.market) < MOVE_COOLDOWN_MS) continue;
    if (f.market === "eu") {
      if (!isDisplayableLiveEuTriplet(prev.h, prev.d, prev.a) || !isDisplayableLiveEuTriplet(f.h, f.d, f.a)) continue;
      if (Math.abs(f.h - prev.h) >= EU_MOVE_MIN) {
        d.prepare(
          "INSERT INTO movements (fixture_id, market, bookmaker, type, from_line, to_line, from_h, to_h, from_a, to_a, sev, t0, t1, phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'滚球')",
        ).run(fixtureId, "eu", "实时盘", "水位", null, null, prev.h, f.h, prev.a, f.a, Math.abs(f.h - prev.h) >= 0.25 ? 1 : 0, prev.captured_at, capturedAt);
        moves++;
      }
      continue;
    }
    if (prev.line == null || f.line == null) continue;
    const mv = detectMovement(f.market, { line: prev.line, h: prev.h, a: prev.a }, { line: f.line, h: f.h, a: f.a });
    if (!mv) continue;
    d.prepare(
      "INSERT INTO movements (fixture_id, market, bookmaker, type, from_line, to_line, from_h, to_h, from_a, to_a, sev, t0, t1, phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'滚球')",
    ).run(fixtureId, mv.market, "实时盘", mv.type, mv.fromLine, mv.toLine, mv.fromH, mv.toH, mv.fromA, mv.toA, mv.sev ? 1 : 0, prev.captured_at, capturedAt);
    moves++;
  }
  return moves;
}

/** 滚球帧序列(走势图滚球段) */
export function liveOddsSeries(fixtureId: number, market: LiveOddsMarket): LiveSnapRow[] {
  return db()
    .prepare("SELECT line, h, a, d, suspended, captured_at FROM live_odds_snapshots WHERE fixture_id=? AND market=? ORDER BY captured_at")
    .all(fixtureId, market) as unknown as LiveSnapRow[];
}

/** 单场三类滚球帧一次性读取,供详情页避免重复扫表。 */
export function liveOddsSeriesByMarket(fixtureId: number): Record<LiveOddsMarket, LiveSnapRow[]> {
  const rows = db()
    .prepare("SELECT market, line, h, a, d, suspended, captured_at FROM live_odds_snapshots WHERE fixture_id=? ORDER BY market, captured_at")
    .all(fixtureId) as unknown as (LiveSnapRow & { market: LiveOddsMarket })[];
  return {
    ah: rows.filter((r) => r.market === "ah"),
    ou: rows.filter((r) => r.market === "ou"),
    eu: rows.filter((r) => r.market === "eu"),
  };
}

/** 数据保鲜:完场 >7 天的滚球帧、>30 天的 raw 原始包(每日一次,worker 调) */
export function pruneLiveData(now = Date.now()): { liveRows: number; rawRows: number } {
  const d = db();
  const r1 = d
    .prepare(
      "DELETE FROM live_odds_snapshots WHERE fixture_id IN (SELECT fixture_id FROM fixtures_cache WHERE kickoff_utc < ? AND status IN ('FT','AET','PEN','AWD','WO'))",
    )
    .run(now - 7 * 86_400_000);
  const r2 = d.prepare("DELETE FROM odds_raw WHERE captured_at < ?").run(now - 30 * 86_400_000);
  const r3 = d.prepare("DELETE FROM af_raw_payloads WHERE fetched_at < ?").run(now - 30 * 86_400_000);
  return { liveRows: Number(r1.changes), rawRows: Number(r2.changes) + Number(r3.changes) };
}
