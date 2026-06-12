import { describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import type { Panorama } from "../../src/server/af/panorama";
import { _resetDbForTest } from "../../src/server/db";
import { buildReport, buildReportSummary } from "../../src/server/views/report";

function pano(): Panorama {
  return {
    fixture: {
      fixture_id: 77,
      league_id: 39,
      season: 2026,
      league_name: "Premier League",
      round: "Regular Season - 1",
      kickoff_utc: Date.parse("2026-06-12T12:00:00Z"),
      status: "NS",
      elapsed: null,
      home_id: 50,
      home_name: "Manchester City",
      away_id: 42,
      away_name: "Arsenal",
      goals_home: null,
      goals_away: null,
      payload: "{}",
      updated_at: Date.now(),
    },
    bundle: {},
    odds: {
      ah: [{ fixture_id: 77, bookmaker_id: 8, bookmaker: "Bet365", market: "ah", line: 0.5, h: 0.9, a: 0.96, d: null, captured_at: 1000 }],
      ou: [{ fixture_id: 77, bookmaker_id: 8, bookmaker: "Bet365", market: "ou", line: 2.5, h: 0.88, a: 0.98, d: null, captured_at: 1000 }],
      eu: [],
      compareAh: [],
      compareOu: [],
      compareEu: [],
    },
    movements: [],
    prediction: {
      predictions: {
        winner: { id: 50, name: "Manchester City" },
        win_or_draw: false,
        under_over: "+2.5",
        percent: { home: "55%", draw: "25%", away: "20%" },
      },
      comparison: {
        att: { home: "61%", away: "39%" },
        def: { home: "58%", away: "42%" },
      },
    },
    injuries: [{ team: { id: 50 }, player: { name: "Player A", reason: "Knock", type: "Questionable" } }],
    deep: null,
  };
}

describe("buildReportSummary", () => {
  it("uses the same probability contract as the full report builder", () => {
    _resetDbForTest();
    const p = pano();

    expect(buildReportSummary(p)).toEqual(buildReport(p).ps);
  });
});
