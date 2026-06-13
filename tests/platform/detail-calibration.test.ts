import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

vi.mock("../../src/server/af/catalog", () => ({
  runAfEndpoint: vi.fn(async (key: string) => {
    if (key === "standings") {
      const row = (teamId: number, team: string, rank: number, group: string, played = 1, points = 0, gd = 0) => ({
        rank,
        group,
        points,
        goalsDiff: gd,
        team: { id: teamId, name: team },
        all: { played, win: points === 3 ? 1 : 0, draw: 0, lose: points === 0 && played > 0 ? 1 : 0 },
      });
      return {
        response: [{
          league: {
            standings: [
              [
                row(16, "Mexico", 1, "Group Stage - Group A", 1, 3, 2),
                row(17, "South Korea", 2, "Group Stage - Group A", 1, 3, 1),
                row(770, "Czechia", 3, "Group Stage - Group A", 1, 0, -1),
                row(1531, "South Africa", 4, "Group Stage - Group A", 1, 0, -2),
              ],
              [
                row(22, "Iran", 1, "Group Stage", 0, 0, 0),
                row(770, "Czechia", 12, "Group Stage", 1, 0, -1),
              ],
            ],
          },
        }],
      };
    }
    return { response: [] };
  }),
}));

import { _resetDbForTest, db } from "../../src/server/db";
import { marketOverview } from "../../src/server/markets/overview";
import { detailView } from "../../src/server/views/detail";
import type { Panorama } from "../../src/server/af/panorama";

beforeEach(() => _resetDbForTest());

function basePanorama(): Panorama {
  return {
    fixture: {
      fixture_id: 1538999,
      league_id: 1,
      season: 2026,
      league_name: "World Cup",
      round: "Group Stage - 1",
      kickoff_utc: Date.parse("2026-06-12T02:00:00Z"),
      status: "FT",
      elapsed: 90,
      home_id: 17,
      home_name: "South Korea",
      away_id: 770,
      away_name: "Czechia",
      goals_home: 2,
      goals_away: 1,
      payload: "{}",
      updated_at: Date.now(),
    },
    bundle: { fixture: { venue: { city: "" } }, lineups: [] },
    odds: { ah: [], ou: [], eu: [], compareAh: [], compareOu: [], compareEu: [] },
    movements: [],
    prediction: null,
    injuries: [],
    deep: null,
  };
}

describe("external calibration fixes", () => {
  it("exposes public MarketOverview without leaking raw bookmaker names", async () => {
    const p = basePanorama();
    db()
      .prepare("INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(p.fixture.fixture_id, 8, "Bet365", "ah", 0.5, 0.88, 0.98, null, 1000);
    db()
      .prepare("INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(p.fixture.fixture_id, 4, "平博", "ou", 2.5, 0.9, 0.96, null, 1100);
    db()
      .prepare("INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(p.fixture.fixture_id, 8, "Bet365", "eu", null, 1.9, 3.4, 4.2, 1200);
    p.marketOverview = marketOverview(p.fixture.fixture_id);
    p.odds = p.marketOverview.odds;

    const view = await detailView(p, "UTC+8", { deep: false });

    expect(view.marketOverview).not.toBeNull();
    expect(view.marketOverview!.dataQualityScore).toBeGreaterThanOrEqual(70);
    expect(view.marketOverview!.selectedReasons.ah).toContain("覆盖");
    expect(JSON.stringify(view.marketOverview)).not.toContain("Bet365");
    expect(JSON.stringify(view.marketOverview)).not.toContain("平博");
  });

  it("shows live quote row in comparison tables without pretending it is a bookmaker", async () => {
    const p = basePanorama();
    p.fixture.status = "2H";
    p.fixture.elapsed = 58;
    const first = {
      fixture_id: p.fixture.fixture_id,
      bookmaker_id: 8,
      bookmaker: "Bet365",
      market: "ah",
      line: 0.5,
      h: 0.88,
      a: 0.98,
      d: null,
      captured_at: p.fixture.kickoff_utc - 3_600_000,
    };
    const last = { ...first, line: 0.75, h: 0.86, a: 1.0, captured_at: p.fixture.kickoff_utc - 600_000 };
    p.odds.compareAh = [{ bookmaker: "Bet365", first, last }];
    db()
      .prepare("INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(p.fixture.fixture_id, "ah", 0.25, 0.94, 0.9, null, 0, p.fixture.kickoff_utc + 60_000);
    db()
      .prepare("INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(p.fixture.fixture_id, "ah", 0, 0.99, 0.86, null, 0, p.fixture.kickoff_utc + 120_000);

    const view = await detailView(p, "UTC+8", { deep: false });

    expect(view.comp.ah[0]).toMatchObject({
      co: "实时盘",
      bid: null,
      iText: "半球",
      iW: "0.88 / 0.98",
      nText: "平手",
      nW: "0.99 / 0.86",
      live: true,
    });
    expect(view.comp.ah[1]).toMatchObject({ co: "Be***5", bid: 8, nText: "半一" });
  });

  it("filters standings to the shared group when provider also returns a generic group", async () => {
    const view = await detailView(basePanorama(), "UTC+8", { deep: false });
    const table = view.tech.standings.table;

    expect(table.map((r) => r.grp)).toEqual([
      "Group Stage - Group A",
      "Group Stage - Group A",
      "Group Stage - Group A",
      "Group Stage - Group A",
    ]);
    expect(view.tech.standings.pair.map((r) => r.teamId)).toEqual([17, 770]);
  });

  it("uses fixture lineup coaches over stale team-level coach profiles in deep cards", async () => {
    const p = basePanorama();
    p.bundle.lineups = [
      {
        team: { id: 17, name: "South Korea" },
        formation: "3-4-2-1",
        coach: { name: "Hong Myung-bo" },
        startXI: [],
        substitutes: [],
      },
      {
        team: { id: 770, name: "Czechia" },
        formation: "3-4-2-1",
        coach: { name: "Miroslav Koubek" },
        startXI: [],
        substitutes: [],
      },
    ];
    p.deep = {
      topscorers: [],
      topassists: [],
      topyellow: [],
      topred: [],
      coachHome: { name: "Hong Myung-bo", age: 56, nationality: "South Korea", career: [{ start: "2024-01-01", end: null }] },
      coachAway: { name: "Ivan Hasek", age: 62, nationality: "Czechia", career: [{ start: "2024-01-01", end: null }] },
      trophiesHomeCoach: [{ trophy: "A" }],
      trophiesAwayCoach: [{ trophy: "B" }, { trophy: "C" }],
      transfersHome: [],
      transfersAway: [],
      squadHome: null,
      squadAway: null,
      statsHome: null,
      statsAway: null,
    };

    const view = await detailView(p, "UTC+8", { deep: true });
    const coaches = view.deep?.coaches ?? [];

    expect(coaches.find((c) => c.side === "h")).toMatchObject({
      name: "Hong Myung-bo",
      trophies: 1,
    });
    expect(coaches.find((c) => c.side === "a")).toMatchObject({
      name: "Miroslav Koubek",
      meta: "本场阵容主帅 · 资料待同步",
      trophies: null,
    });
    expect(view.deep?.motiv).toContain("Miroslav Koubek:荣誉数据待同步");
  });

  it("does not expose empty leaderboard shells or unusable transfer rows as data", async () => {
    const p = basePanorama();
    p.deep = {
      topscorers: [],
      topassists: [],
      topyellow: [],
      topred: [],
      coachHome: null,
      coachAway: null,
      trophiesHomeCoach: [],
      trophiesAwayCoach: [],
      transfersHome: [{
        player: { name: "Example Player" },
        transfers: [{ date: "", type: "Data unavailable", teams: { in: { id: 17 }, out: { id: 1 } } }],
      }, {
        player: { name: "Data unavailable" },
        transfers: [{ date: "2019-01-07", type: "Transfer", teams: { in: { id: 17 }, out: { id: 1 } } }],
      }],
      transfersAway: [],
      squadHome: null,
      squadAway: null,
      statsHome: null,
      statsAway: null,
    };

    const view = await detailView(p, "UTC+8", { deep: true });

    expect(view.deep?.lb).toEqual([]);
    expect(view.deep?.transfers).toEqual([
      { team: "韩国", tag: "暂无数据", x: "暂未获取到可用转会记录" },
      { team: "捷克", tag: "暂无数据", x: "暂未获取到可用转会记录" },
    ]);
  });
});
