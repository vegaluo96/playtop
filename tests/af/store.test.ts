/** 快照落库 + 异动 diff + 战绩结算(内存库,模拟 AF 信封) */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import {
  archiveOdds,
  archivePrediction,
  fixtureById,
  mainOddsSnapshot,
  mergeFixturePayload,
  modelStats,
  movementsOf,
  oddsBundle,
  oddsCompare,
  oddsSeries,
  settleFixture,
  upsertFixture,
} from "../../src/server/af/store";

function afFixture(id: number, opts: { status?: string; gh?: number; ga?: number } = {}) {
  return {
    fixture: { id, date: "2026-06-11T19:00:00+00:00", status: { short: opts.status ?? "NS", elapsed: null }, venue: { id: 1, name: "X", city: "Y" } },
    league: { id: 39, season: 2025, name: "Premier League", round: "Regular Season - 30" },
    teams: { home: { id: 50, name: "曼城" }, away: { id: 42, name: "阿森纳" } },
    goals: { home: opts.gh ?? null, away: opts.ga ?? null },
  };
}

function odds(line: number, h: number, a: number) {
  return {
    bookmakers: [
      {
        id: 8,
        name: "Bet365",
        bets: [
          {
            id: 4,
            name: "Asian Handicap",
            values: [
              { value: `Home ${-line >= 0 ? "+" : ""}${-line}`, odd: String(1 + h) },
              { value: `Away ${line >= 0 ? "+" : ""}${line}`, odd: String(1 + a) },
            ],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  _resetDbForTest();
});

describe("fixtures_cache", () => {
  it("upsert 用最新基础赛程,但保留已有详情数组", () => {
    upsertFixture(afFixture(100));
    const fx = fixtureById(100)!;
    expect(fx).toMatchObject({ league_id: 39, home_name: "曼城", away_name: "阿森纳", status: "NS" });
    const long = { ...afFixture(100), events: [{ type: "Goal" }] };
    upsertFixture(long);
    const latest = afFixture(100, { status: "FT", gh: 2, ga: 1 });
    (latest.fixture.status as { elapsed: number | null }).elapsed = 90;
    upsertFixture(latest); // 较短的列表帧,但基础状态/比分更新

    const next = fixtureById(100)!;
    const payload = JSON.parse(next.payload);
    expect(next).toMatchObject({ status: "FT", elapsed: 90, goals_home: 2, goals_away: 1 });
    expect(payload.fixture.status.short).toBe("FT");
    expect(payload.goals.home).toBe(2);
    expect(payload.events).toEqual([{ type: "Goal" }]);
  });

  it("mergeFixturePayload 合并独立详情端点,不改基础赛程字段", () => {
    upsertFixture(afFixture(101));
    expect(mergeFixturePayload(101, {
      events: [{ type: "Goal" }],
      lineups: [{ team: { id: 50 }, coach: { name: "Coach A" } }],
      statistics: [{ team: { id: 50 }, statistics: [] }],
    }, 12345)).toBe(true);

    const fx = fixtureById(101)!;
    expect(fx.home_name).toBe("曼城");
    expect(fx.away_name).toBe("阿森纳");
    expect(fx.updated_at).toBe(12345);
    expect(JSON.parse(fx.payload)).toMatchObject({
      events: [{ type: "Goal" }],
      lineups: [{ team: { id: 50 }, coach: { name: "Coach A" } }],
      statistics: [{ team: { id: 50 }, statistics: [] }],
    });
  });
});

describe("odds 归档与异动", () => {
  it("相邻快照 diff:升盘+水位变化生成 movements,序列与百家对比可查", () => {
    upsertFixture(afFixture(200));
    expect(archiveOdds(200, odds(1.25, 0.9, 0.96), 1000)).toBe(0); // 首帧无 diff
    expect(archiveOdds(200, odds(1.5, 0.85, 1.01), 2000)).toBe(1); // 升盘
    const moves = movementsOf(200);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "升盘", sev: 1, bookmaker: "Bet365" });
    expect(oddsSeries(200, "ah")).toHaveLength(2);
    const cmp = oddsCompare(200, "ah");
    expect(cmp[0].first.line).toBe(1.25);
    expect(cmp[0].last.line).toBe(1.5);
  });

  it("数值未变的快照短期内不重复落库", () => {
    upsertFixture(afFixture(201));
    archiveOdds(201, odds(1, 0.9, 0.96), 1000);
    archiveOdds(201, odds(1, 0.9, 0.96), 2000);
    expect(oddsSeries(201, "ah")).toHaveLength(1);
  });

  it("归一化暂未识别市场时仍保留 odds_raw,方便重放修复", () => {
    upsertFixture(afFixture(203));
    expect(archiveOdds(203, { fixture: { id: 203 }, bookmakers: [{ id: 8, name: "Bet365", bets: [] }] }, 3000)).toBe(0);
    const raw = db().prepare("SELECT fixture_id, captured_at, payload FROM odds_raw WHERE fixture_id=?").get(203) as
      | { fixture_id: number; captured_at: number; payload: string }
      | undefined;
    expect(raw).toMatchObject({ fixture_id: 203, captured_at: 3000 });
    expect(JSON.parse(raw!.payload)).toMatchObject({ bookmakers: [{ id: 8, name: "Bet365" }] });
    expect(oddsSeries(203, "ah")).toEqual([]);
  });

  it("主盘按共识盘口+主流书商优先,不被最新离群书商带偏", () => {
    upsertFixture(afFixture(202));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(202, 8, "Bet365", "ou", 2.25, 0.9, 0.95, null, 1000);
    ins.run(202, 4, "平博", "ou", 2.25, 0.92, 0.93, null, 1100);
    ins.run(202, 99, "10Bet", "ou", 2.5, 0.88, 0.9, null, 5000);
    expect(mainOddsSnapshot(202, "ou")).toMatchObject({ bookmaker: "Bet365", line: 2.25 });
    expect(oddsSeries(202, "ou").at(-1)).toMatchObject({ bookmaker: "Bet365", line: 2.25 });
  });

  it("oddsBundle 与单市场走势/百家对比口径一致", () => {
    upsertFixture(afFixture(204));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(204, 8, "Bet365", "ah", 0.5, 0.9, 0.96, null, 1000);
    ins.run(204, 8, "Bet365", "ah", 0.5, 0.88, 0.98, null, 2000);
    ins.run(204, 4, "平博", "ah", 0.5, 0.91, 0.95, null, 2100);
    ins.run(204, 99, "10Bet", "ah", 0.75, 0.86, 1.0, null, 5000);
    ins.run(204, 8, "Bet365", "eu", null, 1.6, 3.8, 5.2, 1000);
    ins.run(204, 8, "Bet365", "eu", null, 1.55, 3.9, 5.4, 2000);
    ins.run(204, 4, "平博", "eu", null, 1.58, 3.85, 5.1, 2100);

    const bundle = oddsBundle(204);

    expect(bundle.ah).toEqual(oddsSeries(204, "ah"));
    expect(bundle.eu).toEqual(oddsSeries(204, "eu"));
    expect(bundle.compareAh).toEqual(oddsCompare(204, "ah"));
    expect(bundle.compareEu).toEqual(oddsCompare(204, "eu"));
  });
});

describe("模型战绩结算", () => {
  it("FT 后按预测 winner 对照比分;统计聚合正确", () => {
    upsertFixture(afFixture(300, { status: "FT", gh: 2, ga: 1 }));
    archivePrediction(300, {
      predictions: { winner: { id: 50, name: "曼城" }, win_or_draw: false, percent: { home: "58%", draw: "22%", away: "20%" } },
    });
    settleFixture(fixtureById(300)!);
    const s = modelStats(Date.parse("2026-06-12T04:00:00Z"));
    expect(s.hitRate30).toBe(100);
    expect(s.yesterdayRows.length + s.week.reduce((n, w) => n + w.total, 0)).toBeGreaterThan(0);
  });

  it("无预测快照的完场不结算", () => {
    upsertFixture(afFixture(301, { status: "FT", gh: 0, ga: 0 }));
    settleFixture(fixtureById(301)!);
    expect(modelStats().hitRate30).toBeNull();
  });
});
