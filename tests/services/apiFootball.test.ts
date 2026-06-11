import { describe, expect, it } from "vitest";

import {
  afFixtureFinished,
  matchAfFixture,
  parseAfCoach,
  parseAfFixtures,
  parseAfH2h,
  parseAfInjuries,
  parseAfLineups,
  parseAfOddsBooks,
  parseAfSquad,
  parseAfStandings,
  parseAfTeamStats,
  parseAfTopScorers,
  parseAfTeamFixtures,
  parseAfFixtureStats,
} from "@/server/datasources/apiFootball";

const T0 = Date.UTC(2026, 5, 11, 18, 0);

const fixturesJson = {
  response: [
    {
      fixture: { id: 1001, timestamp: T0 / 1000, status: { short: "NS" }, referee: "F. Rapallini" },
      league: { id: 1, name: "World Cup", season: 2026 },
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
    expect(hit?.referee).toBe("F. Rapallini");
    expect(hit?.leagueId).toBe(1);
    expect(hit?.season).toBe(2026);
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

describe("API-Football 名单/积分榜解析", () => {
  it("球队名单：位置映射与防御", () => {
    const squad = {
      response: [
        {
          players: [
            { name: "G One", age: 30, number: 1, position: "Goalkeeper" },
            { name: "D Two", age: 25, number: 4, position: "Defender" },
            { name: "X Three", age: null, number: null, position: "Coach?" },
          ],
        },
      ],
    };
    const players = parseAfSquad(squad);
    expect(players).toHaveLength(3);
    expect(players[0]).toMatchObject({ name: "G One", role: "goalkeeper", number: 1 });
    expect(players[2].role).toBe("unknown");
    expect(parseAfSquad({})).toEqual([]);
  });

  it("积分榜：分组扁平化，按 teamId 找排名", () => {
    const standings = {
      response: [
        {
          league: {
            standings: [
              [
                { rank: 1, team: { id: 33, name: "Mexico" }, points: 6, goalsDiff: 3, group: "Group A", all: { played: 2 } },
                { rank: 2, team: { id: 44, name: "South Africa" }, points: 4, goalsDiff: 1, group: "Group A", all: { played: 2 } },
              ],
              [{ rank: 1, team: { id: 99, name: "Brazil" }, points: 6, goalsDiff: 5, group: "Group B", all: { played: 2 } }],
            ],
          },
        },
      ],
    };
    const rows = parseAfStandings(standings);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.teamId === 44)).toMatchObject({ rank: 2, points: 4, group: "Group A", played: 2 });
    expect(parseAfStandings({ response: [] })).toEqual([]);
  });
});

describe("API-Football 富化端点解析（Ultra 配额）", () => {
  it("历史交锋：按本场主客归并胜平负，取近 10 场", () => {
    const json = {
      response: [
        // 本场主队=33。该场 33 主场 2:0 → 本场主队胜
        { fixture: { id: 1, timestamp: 1_700_000_000, status: { short: "FT" } }, league: { name: "WC" }, teams: { home: { id: 33, name: "Mexico" }, away: { id: 44, name: "RSA" } }, score: { fulltime: { home: 2, away: 0 } } },
        // 该场 44 主场 1:1 → 平
        { fixture: { id: 2, timestamp: 1_600_000_000, status: { short: "FT" } }, league: { name: "WC" }, teams: { home: { id: 44, name: "RSA" }, away: { id: 33, name: "Mexico" } }, score: { fulltime: { home: 1, away: 1 } } },
        // 该场 44 主场 3:0 → 本场客队(44)胜
        { fixture: { id: 3, timestamp: 1_500_000_000, status: { short: "FT" } }, league: { name: "WC" }, teams: { home: { id: 44, name: "RSA" }, away: { id: 33, name: "Mexico" } }, score: { fulltime: { home: 3, away: 0 } } },
        // 未完场不计
        { fixture: { id: 4, timestamp: 1_800_000_000, status: { short: "NS" } }, league: { name: "WC" }, teams: { home: { id: 33, name: "Mexico" }, away: { id: 44, name: "RSA" } }, score: { fulltime: { home: null, away: null } } },
      ],
    };
    const h2h = parseAfH2h(json, 33, 44)!;
    expect(h2h.summary).toEqual({ total: 3, homeWins: 1, draws: 1, awayWins: 1 });
    expect(h2h.matches[0].playedAt).toBeGreaterThan(h2h.matches[1].playedAt); // 倒序
    expect(parseAfH2h({ response: [] }, 33, 44)).toBeNull();
  });

  it("球队赛季统计：字符串均值转数字 + 主用阵型 + 近期战绩串", () => {
    const json = {
      response: {
        form: "WLWWDLWW",
        fixtures: { played: { home: 5, away: 5, total: 10 } },
        goals: { for: { average: { home: "2.0", away: "1.0", total: "1.5" } }, against: { average: { home: "0.8", away: "1.2", total: "1.0" } } },
        clean_sheet: { total: 4 },
        lineups: [{ formation: "4-3-3", played: 7 }, { formation: "4-2-3-1", played: 3 }],
      },
    };
    const s = parseAfTeamStats(json)!;
    expect(s.matches).toBe(10);
    expect(s.gfPerGame).toBe(1.5);
    expect(s.gaPerGame).toBe(1.0);
    expect(s.cleanSheetRate).toBe(0.4);
    expect(s.formation).toBe("4-3-3"); // 出场最多
    expect(s.form).toBe("WWDLWW"); // 取末 6 场
    expect(parseAfTeamStats({ response: { fixtures: { played: { total: 0 } } } })).toBeNull();
  });

  it("主教练：取 career 中 end=null 的当前队", () => {
    const json = {
      response: [
        { name: "Aguirre", career: [{ team: { id: 33 }, end: null }, { team: { id: 99 }, end: "2024-01-01" }] },
        { name: "Old Coach", career: [{ team: { id: 33 }, end: "2023-01-01" }] },
      ],
    };
    expect(parseAfCoach(json, 33)).toBe("Aguirre");
    expect(parseAfCoach({ response: [] }, 33)).toBeNull();
  });

  it("联赛射手榜：按 teamId + 进球数", () => {
    const json = {
      response: [
        { player: { name: "Striker A" }, statistics: [{ team: { id: 33 }, goals: { total: 12 } }] },
        { player: { name: "Striker B" }, statistics: [{ team: { id: 44 }, goals: { total: 9 } }] },
      ],
    };
    const rows = parseAfTopScorers(json);
    expect(rows).toEqual([
      { teamId: 33, player: "Striker A", goals: 12 },
      { teamId: 44, player: "Striker B", goals: 9 },
    ]);
    expect(parseAfTopScorers({})).toEqual([]);
  });

  it("fixture 解析提取场馆名/城市", () => {
    const json = { response: [{ fixture: { id: 7, timestamp: 1_700_000_000, status: { short: "NS" }, venue: { name: "Estadio Azteca", city: "Mexico City" } }, league: { id: 1, name: "WC", season: 2026 }, teams: { home: { id: 33, name: "MX" }, away: { id: 44, name: "RSA" } }, score: { fulltime: { home: null, away: null } } }] };
    const f = parseAfFixtures(json)[0];
    expect(f.venueName).toBe("Estadio Azteca");
    expect(f.venueCity).toBe("Mexico City");
  });
});

describe("API-Football 近期状态（fixtures/statistics：射门质量）", () => {
  it("近 N 场相对该队的进失球/对手/主客", () => {
    const json = {
      response: [
        { fixture: { id: 10, timestamp: 1_700_000_000, status: { short: "FT" } }, league: { name: "L" }, teams: { home: { id: 33, name: "MX" }, away: { id: 50, name: "USA" } }, score: { fulltime: { home: 3, away: 1 } } },
        { fixture: { id: 11, timestamp: 1_690_000_000, status: { short: "FT" } }, league: { name: "L" }, teams: { home: { id: 60, name: "CAN" }, away: { id: 33, name: "MX" } }, score: { fulltime: { home: 2, away: 0 } } },
      ],
    };
    const rows = parseAfTeamFixtures(json, 33);
    expect(rows).toHaveLength(2);
    expect(rows[0].m).toMatchObject({ opponent: "USA", venue: "home", goalsFor: 3, goalsAgainst: 1 });
    expect(rows[1].m).toMatchObject({ opponent: "CAN", venue: "away", goalsFor: 0, goalsAgainst: 2 });
  });

  it("单场统计：射门/射正/控球%/xG，按 teamId 取，缺失部分", () => {
    const json = {
      response: [
        { team: { id: 33 }, statistics: [{ type: "Total Shots", value: 14 }, { type: "Shots on Goal", value: 6 }, { type: "Ball Possession", value: "58%" }, { type: "expected_goals", value: "2.1" }] },
        { team: { id: 50 }, statistics: [{ type: "Total Shots", value: 8 }] },
      ],
    };
    expect(parseAfFixtureStats(json, 33)).toEqual({ shots: 14, shotsOnTarget: 6, possession: 58, xg: 2.1 });
    expect(parseAfFixtureStats(json, 50)).toEqual({ shots: 8, shotsOnTarget: undefined, possession: undefined, xg: undefined });
    expect(parseAfFixtureStats({ response: [] }, 33)).toEqual({});
  });
});

describe("API-Football 盘口全量拉取（不截断）", () => {
  it("全部书商入库（远超旧 8 家上限），锐盘排前", () => {
    const mk = (name: string, h: string) => ({
      name,
      bets: [{ name: "Match Winner", values: [{ value: "Home", odd: h }, { value: "Draw", odd: "3.40" }, { value: "Away", odd: "3.80" }] }],
    });
    const names = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "Pinnacle", "Bet365"];
    const json = { response: [{ bookmakers: names.map((n, i) => mk(n, (1.9 + i * 0.01).toFixed(2))) }] };
    const books = parseAfOddsBooks(json, 0);
    expect(books.length).toBe(14); // 14 家全收，不再砍到 8
    expect(books[0].bookmaker).toBe("Pinnacle"); // 锐盘排最前
    expect(books[1].bookmaker).toBe("bet365");
  });

  it("亚盘/大小球多线全收（不再砍到 6 条）", () => {
    const ouVals = [];
    const ahVals = [];
    for (let i = 0; i < 12; i++) {
      const line = (0.5 + i * 0.5).toFixed(1);
      ouVals.push({ value: `Over ${line}`, odd: "1.90" }, { value: `Under ${line}`, odd: "1.90" });
      const ah = (i - 6) * 0.5;
      ahVals.push({ value: `Home ${ah >= 0 ? "+" : ""}${ah}`, odd: "1.95" }, { value: `Away ${-ah >= 0 ? "+" : ""}${-ah}`, odd: "1.95" });
    }
    const json = { response: [{ bookmakers: [{ name: "Bet365", bets: [{ name: "Goals Over/Under", values: ouVals }, { name: "Asian Handicap", values: ahVals }] }] }] };
    const book = parseAfOddsBooks(json, 0)[0];
    expect(book.ou.length).toBe(12); // 12 条线全收
    expect(book.ah.length).toBeGreaterThanOrEqual(11);
  });
});
