import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import type { Panorama } from "../../src/server/af/panorama";
import { db, _resetDbForTest } from "../../src/server/db";
import { buildReportSummary } from "../../src/server/views/report";
import { buildReportSignals, type PublicMarketSignal } from "../../src/server/views/report-signals";
import { buildReportSourceCoverage, publicSourceCoverage, sourceCoverageNeedsRebuild } from "../../src/server/views/source-coverage";

const fixture = {
  fixture_id: 8801,
  league_id: 1,
  season: 2026,
  league_name: "World Cup",
  round: "Group - 1",
  kickoff_utc: Date.parse("2026-06-14T03:00:00Z"),
  status: "NS",
  elapsed: null,
  home_id: 10,
  home_name: "Canada",
  away_id: 20,
  away_name: "Bosnia & Herzegovina",
  goals_home: null,
  goals_away: null,
  payload: "{}",
  updated_at: 1_000,
};

function pano(overrides: Partial<Panorama> = {}): Panorama {
  return {
    fixture,
    bundle: { fixture: { venue: { city: "Toronto" } } },
    odds: {
      ah: [{ fixture_id: 8801, bookmaker_id: 8, bookmaker: "Bet365", market: "ah", line: 0.5, h: 0.88, a: 0.98, d: null, captured_at: 1_200 }],
      ou: [{ fixture_id: 8801, bookmaker_id: 8, bookmaker: "Bet365", market: "ou", line: 2.5, h: 0.92, a: 0.94, d: null, captured_at: 1_300 }],
      eu: [{ fixture_id: 8801, bookmaker_id: 8, bookmaker: "Bet365", market: "eu", line: null, h: 1.8, a: 4.2, d: 3.4, captured_at: 1_400 }],
      compareAh: [],
      compareOu: [],
      compareEu: [],
    },
    marketOverview: undefined,
    movements: [],
    prediction: {
      predictions: {
        winner: { id: 10, name: "Canada" },
        win_or_draw: false,
        under_over: "-2.5",
        percent: { home: "52%", draw: "26%", away: "22%" },
      },
      teams: { home: { league: { form: "WWDLW" } }, away: { league: { form: "LDWDL" } } },
      comparison: { total: { home: "58%", away: "42%" } },
    },
    injuries: [{ team: { id: 20 }, player: { name: "Away Player" } }],
    deep: null,
    ...overrides,
  };
}

function market(overrides: Partial<PublicMarketSignal> = {}): PublicMarketSignal {
  return {
    status: "ok",
    note: "命中 Polymarket 单场预测市场",
    source: "Polymarket",
    side: "home",
    homeProb: 0.52,
    drawProb: 0.26,
    awayProb: 0.22,
    capturedAt: 1_500,
    matchScore: 86,
    marketType: "matchWinner",
    needsReview: false,
    ...overrides,
  };
}

beforeEach(() => {
  _resetDbForTest();
});

describe("report sourceCoverage", () => {
  it("marks real AF predictions, prematch odds and Polymarket as used", () => {
    db().prepare("INSERT INTO predictions_snapshots (fixture_id, payload, captured_at) VALUES (?,?,?)")
      .run(8801, JSON.stringify(pano().prediction), 1_100);
    db().prepare("INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(8801, 8, "Bet365", "ah", 0.5, 0.88, 0.98, null, 1_200);
    const p = pano();
    const ps = buildReportSummary(p);
    const signals = buildReportSignals(ps, p.odds, market(), p);
    const coverage = buildReportSourceCoverage(p, signals);

    expect(coverage.afPredictions).toMatchObject({ status: "used", usedInReport: true });
    expect(coverage.polymarket).toMatchObject({ status: "used", usedInReport: true });
    expect(coverage.prematchOdds).toMatchObject({ status: "used", usedInReport: true });
    expect(coverage.statistics).toMatchObject({ status: "missing", usedInReport: false });
  });

  it("does not treat missing predictions as report input", () => {
    const p = pano({ odds: { ah: [], ou: [], eu: [], compareAh: [], compareOu: [], compareEu: [] }, prediction: null, injuries: [] });
    const signals = buildReportSignals(null, p.odds, { status: "skipped", note: "未请求" }, p);
    const coverage = buildReportSourceCoverage(p, signals);

    expect(coverage.afPredictions.status).toBe("missing");
    expect(coverage.afPredictions.usedInReport).toBe(false);
    expect(coverage.prematchOdds.status).toBe("missing");
    expect(coverage.polymarket.usedInReport).toBe(false);
  });

  it("marks report stale when a source snapshot arrives after generation", () => {
    db().prepare("INSERT INTO predictions_snapshots (fixture_id, payload, captured_at) VALUES (?,?,?)")
      .run(8801, JSON.stringify(pano().prediction), 70_000);
    const p = pano();
    const signals = buildReportSignals(buildReportSummary(p), p.odds, market({ capturedAt: 70_200 }), p);
    const coverage = buildReportSourceCoverage(p, signals, { reportGeneratedAt: 1_000 });

    expect(coverage.afPredictions.status).toBe("stale");
    expect(coverage.polymarket.status).toBe("stale");
    expect(sourceCoverageNeedsRebuild(coverage)).toBe(true);
  });

  it("publishes user-safe coverage without internal source names or endpoints", () => {
    const p = pano({ prediction: null, injuries: [] });
    const signals = buildReportSignals(null, p.odds, { status: "skipped", note: "已开赛,不使用即时预测市场避免赛后价格污染" }, p);
    const publicCoverage = publicSourceCoverage(buildReportSourceCoverage(p, signals));

    expect(publicCoverage.afPredictions).toMatchObject({
      label: "预测概率",
      status: "missing",
      reason: "预测概率数据积累中",
      usedInReport: false,
    });
    expect(publicCoverage.polymarket.reason).toBe("已开赛,没有可用的赛前预测市场快照");
    expect(JSON.stringify(publicCoverage)).not.toMatch(/API-Football|endpoint|worker|AF /i);
  });
});
