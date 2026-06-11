import { describe, expect, it } from "vitest";

import {
  afFixtureFinished,
  matchAfFixture,
  parseAfFixtures,
  parseAfInjuries,
  parseAfLineups,
  parseAfOddsBooks,
} from "@/server/datasources/apiFootball";

const T0 = Date.UTC(2026, 5, 11, 18, 0);

const fixturesJson = {
  response: [
    {
      fixture: { id: 1001, timestamp: T0 / 1000, status: { short: "NS" } },
      league: { name: "World Cup" },
      teams: { home: { id: 33, name: "Mexico" }, away: { id: 44, name: "South Africa" } },
      score: { fulltime: { home: null, away: null } },
    },
    {
      // 加时赛场次：fulltime 字段就是 90 分钟比分（goals 字段含加时，故不读 goals）
      fixture: { id: 1002, timestamp: (T0 - 4 * 3_600_000) / 1000, status: { short: "AET" } },
      league: { name: "World Cup" },
      teams: { home: { id: 55, name: "Brazil" }, away: { id: 66, name: "Chile" } },
      score: { fulltime: { home: 1, away: 1 } },
    },
  ],
};

describe("API-Football 赛程/赛果解析", () => {
  it("解析 fixtures 并按双队名+时间窗匹配", () => {
    const fixtures = parseAfFixtures(fixturesJson);
    expect(fixtures).toHaveLength(2);
    const hit = matchAfFixture(fixtures, { homeNames: ["Mexico", "墨西哥"], awayNames: ["South Africa"], kickoffAt: T0 + 60_000 });
    expect(hit?.fixtureId).toBe(1001);
    expect(hit?.homeId).toBe(33);
    // 队名不符不匹配
    expect(matchAfFixture(fixtures, { homeNames: ["Ghana"], awayNames: ["South Africa"], kickoffAt: T0 })).toBeNull();
  });

  it("FT/AET 用 fulltime（90 分钟口径），未完场不算", () => {
    const [ns, aet] = parseAfFixtures(fixturesJson);
    expect(afFixtureFinished(ns)).toBe(false);
    expect(afFixtureFinished(aet)).toBe(true);
    expect(aet.ftHome).toBe(1);
    expect(aet.ftAway).toBe(1);
  });
});

const oddsJson = {
  response: [
    {
      bookmakers: [
        {
          name: "SmallBook",
          bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.30" }, { value: "Away", odd: "3.60" }] }],
        },
        {
          name: "Bet365",
          bets: [
            { name: "Match Winner", values: [{ value: "Home", odd: "2.05" }, { value: "Draw", odd: "3.40" }, { value: "Away", odd: "3.70" }] },
            {
              name: "Goals Over/Under",
              values: [
                { value: "Over 2.5", odd: "1.95" },
                { value: "Under 2.5", odd: "1.87" },
                { value: "Over 3.5", odd: "3.20" }, // 无对侧 → 丢弃
              ],
            },
            {
              name: "Asian Handicap",
              values: [
                { value: "Home -0.5", odd: "2.02" },
                { value: "Away +0.5", odd: "1.84" },
              ],
            },
            {
              name: "Exact Score",
              values: Array.from({ length: 10 }, (_, i) => ({ value: `${i % 4}:${i % 3}`, odd: String(6 + i) })),
            },
          ],
        },
      ],
    },
  ],
};

describe("API-Football 盘口解析", () => {
  it("书商名映射 bookWeights 键，大书商排前，市场齐备", () => {
    const books = parseAfOddsBooks(oddsJson, T0);
    expect(books).toHaveLength(2);
    expect(books[0].bookmaker).toBe("bet365"); // Bet365 → bet365（优先序在 SmallBook 前）
    expect(books[0].oneXTwo).toEqual({ home: 2.05, draw: 3.4, away: 3.7 });
    expect(books[0].ou).toEqual([{ line: 2.5, over: 1.95, under: 1.87 }]);
    expect(books[0].ah).toEqual([{ line: -0.5, home: 2.02, away: 1.84 }]); // Away +0.5 与 Home -0.5 合并为主让 -0.5
    expect(books[0].correctScores!.length).toBeGreaterThanOrEqual(8);
    expect(books[1].bookmaker).toBe("SmallBook");
  });

  it("空响应/无效赔率防御", () => {
    expect(parseAfOddsBooks({ response: [] }, T0)).toEqual([]);
    expect(parseAfOddsBooks({}, T0)).toEqual([]);
  });
});

describe("API-Football 首发/伤停解析", () => {
  const lineupsJson = {
    response: [
      { team: { id: 44 }, formation: "4-3-3", startXI: Array.from({ length: 11 }, (_, i) => ({ player: { name: `A${i}` } })) },
      { team: { id: 33 }, formation: "4-2-3-1", startXI: Array.from({ length: 11 }, (_, i) => ({ player: { name: `H${i}` } })) },
    ],
  };

  it("按 team.id 区分主客，confirmed=true", () => {
    const l = parseAfLineups(lineupsJson, 33)!;
    expect(l.confirmed).toBe(true);
    expect(l.home.formation).toBe("4-2-3-1");
    expect(l.home.starters[0]).toBe("H0");
    expect(l.away.starters).toHaveLength(11);
  });

  it("首发不足 7 人（未公布/残缺）不入库", () => {
    const partial = { response: [{ team: { id: 33 }, formation: null, startXI: [{ player: { name: "X" } }] }, { team: { id: 44 }, formation: null, startXI: [] }] };
    expect(parseAfLineups(partial, 33)).toBeNull();
  });

  it("伤停按主客归边，过滤无关球队", () => {
    const inj = {
      response: [
        { player: { name: "P1", type: "Missing Fixture", reason: "Knee Injury" }, team: { id: 33 } },
        { player: { name: "P2", type: null, reason: null }, team: { id: 44 } },
        { player: { name: "P3", type: "Questionable", reason: null }, team: { id: 99 } },
      ],
    };
    const parsed = parseAfInjuries(inj, 33, 44)!;
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({ team: "home", player: "P1", status: "Missing Fixture", note: "Knee Injury" });
    expect(parsed.items[1]).toMatchObject({ team: "away", player: "P2", status: "伤停" });
  });
});
