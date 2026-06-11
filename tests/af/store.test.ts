/** 快照落库 + 异动 diff + 战绩结算(内存库,模拟 AF 信封) */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest } from "../../src/server/db";
import {
  archiveOdds,
  archivePrediction,
  fixtureById,
  modelStats,
  movementsOf,
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
  it("upsert 解析关键列;短 payload 不覆盖长 payload(保 bundle)", () => {
    upsertFixture(afFixture(100));
    const fx = fixtureById(100)!;
    expect(fx).toMatchObject({ league_id: 39, home_name: "曼城", away_name: "阿森纳", status: "NS" });
    const long = { ...afFixture(100), events: [{ type: "Goal" }] };
    upsertFixture(long);
    upsertFixture(afFixture(100)); // 较短的列表帧
    expect(fixtureById(100)!.payload).toContain("events");
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
