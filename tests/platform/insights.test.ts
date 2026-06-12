/** 指数洞察:盘路分类(主客视角/四分之一球)、凯利与离散、升降盘、同赔历史 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import { ahResult, euKelly, insightsView, kellyOf, lineTrend, ouResult, payoutRate, teamRoad } from "../../src/server/views/insights";
import type { FixtureRow } from "../../src/server/af/store";

beforeEach(() => _resetDbForTest());

const DAY = 86_400_000;
const NOW = 1_900_000_000_000;

function seedFixture(id: number, daysAgo: number, homeId: number, awayId: number, gh: number, ga: number, status = "FT") {
  db().prepare(
    `INSERT INTO fixtures_cache (fixture_id, league_id, season, league_name, round, kickoff_utc, status, home_id, home_name, away_id, away_name, goals_home, goals_away, payload, updated_at)
     VALUES (?,39,2025,'PL','1',?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, NOW - daysAgo * DAY, status, homeId, `T${homeId}`, awayId, `T${awayId}`, gh, ga, "{}", NOW);
}
function seedSnap(fid: number, market: string, line: number | null, h: number, a: number, d: number | null, at: number) {
  seedSnapBook(fid, 8, "Bet365", market, line, h, a, d, at);
}
function seedSnapBook(fid: number, bookmakerId: number, bookmaker: string, market: string, line: number | null, h: number, a: number, d: number | null, at: number) {
  db().prepare(
    "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(fid, bookmakerId, bookmaker, market, line, h, a, d, at);
}

describe("盘路分类", () => {
  it("让球:含四分之一球半赢半输与走盘", () => {
    expect(ahResult(1)).toBe("赢");
    expect(ahResult(0.25)).toBe("赢半");
    expect(ahResult(0)).toBe("走");
    expect(ahResult(-0.25)).toBe("输半");
    expect(ahResult(-2)).toBe("输");
    expect(ouResult(0.5)).toBe("大");
    expect(ouResult(-0.25)).toBe("小半");
  });

  it("teamRoad:收盘帧×比分,客队视角让球取反;战绩聚合与连续命中", () => {
    // 队 100:两场主胜赢盘 + 一场客负输盘
    seedFixture(1, 10, 100, 200, 2, 0); // 主 让0.5 赢
    seedSnap(1, "ah", 0.5, 0.9, 0.96, null, NOW - 10 * DAY - 3_600_000);
    seedFixture(2, 7, 100, 300, 1, 0); // 主 让0.75(净胜1 → diff 0.25 赢半)
    seedSnap(2, "ah", 0.75, 0.9, 0.96, null, NOW - 7 * DAY - 3_600_000);
    seedFixture(3, 4, 400, 100, 1, 1); // 客 对方让0.5 → 客视角受让 +0.5 → teamDiff +0.5 赢
    seedSnap(3, "ah", 0.5, 0.9, 0.96, null, NOW - 4 * DAY - 3_600_000);
    seedSnap(3, "ou", 2.5, 0.9, 0.96, null, NOW - 4 * DAY - 3_600_000); // 总分2 → 小
    const r = teamRoad(100, NOW);
    expect(r.ah.rows.map((x) => x.res)).toEqual(["赢", "赢半", "赢"]); // 最近在前
    expect(r.ah.rows[0].ha).toBe("客");
    expect(r.ah.rows[0].line).toBe("受半球"); // 客队视角受让
    expect(r.ah.agg).toMatchObject({ n: 3, win: 3, lose: 0, push: 0, rate: 100, streak: "连赢3" });
    expect(r.ou.rows[0].res).toBe("小");
  });

  it("无归档指数的比赛不入盘路;未完场不入", () => {
    seedFixture(5, 3, 100, 200, 2, 0); // 无快照
    seedFixture(6, 1, 100, 200, 1, 0, "NS");
    expect(teamRoad(100, NOW).ah.rows).toHaveLength(0);
  });
});

describe("凯利/离散/升降盘/返还率", () => {
  it("euKelly:≥3 家出共识;单家公司报价×共识概率,>1 可识别", () => {
    const m = euKelly([
      { h: 2.0, d: 3.4, a: 3.6 },
      { h: 2.05, d: 3.4, a: 3.5 },
      { h: 2.6, d: 3.3, a: 3.0 }, // 主胜定价明显偏高的一家
    ])!;
    expect(m.books).toBe(3);
    expect(m.prob.h + m.prob.d + m.prob.a).toBeCloseTo(1, 9);
    expect(kellyOf(2.6, m.prob.h)!).toBeGreaterThan(1); // 离群家主胜凯利 >1
    expect(kellyOf(2.0, m.prob.h)!).toBeLessThan(1);
    expect(m.disp.h).toBeGreaterThan(m.disp.d); // 主胜分歧大于平局
    expect(euKelly([{ h: 2, d: 3.4, a: 3.6 }])).toBeNull(); // 归档样本未达阈值
  });

  it("lineTrend 统计升降持平;payoutRate 双向/三向", () => {
    expect(
      lineTrend([
        { first: { line: 0.5 }, last: { line: 0.75 } },
        { first: { line: 0.5 }, last: { line: 0.5 } },
        { first: { line: 0.5 }, last: { line: 0.25 } },
      ]),
    ).toEqual({ up: 1, down: 1, flat: 1 });
    expect(payoutRate({ h: 1.9, a: 1.9 })).toBeCloseTo(95, 0);
    expect(payoutRate({ h: 2.0, d: 3.4, a: 3.6 })).toBeLessThan(95);
    expect(payoutRate(null)).toBeNull();
  });
});

describe("insightsView:同赔历史 + 疲劳", () => {
  it("初盘三元组 ±0.03 匹配完场样本;疲劳=距上场天数+未来7天赛程", async () => {
    // 当前场:首帧 2.00/3.40/3.60
    seedFixture(10, -1, 100, 200, 0, 0, "NS"); // 明天开球
    seedSnap(10, "eu", null, 2.0, 3.6, 3.4, NOW - DAY);
    // 同赔完场样本 ×2(一主胜一客胜),一场超容差
    seedFixture(11, 30, 300, 400, 2, 1);
    seedSnap(11, "eu", null, 2.01, 3.58, 3.42, NOW - 31 * DAY);
    seedFixture(12, 20, 500, 600, 0, 1);
    seedSnap(12, "eu", null, 1.99, 3.61, 3.38, NOW - 21 * DAY);
    seedFixture(13, 15, 700, 800, 3, 0);
    seedSnap(13, "eu", null, 2.3, 3.3, 3.1, NOW - 16 * DAY); // 不匹配
    // 疲劳:主队 100 上一场距本场开球 3 天,未来 7 天再 1 场
    seedFixture(14, 2, 100, 900, 1, 1); // 本场开球 = NOW+1d,上一场 NOW-2d → 间隔 3 天
    seedFixture(15, -3, 900, 100, 0, 0, "NS"); // 开球后 2 天再赛
    const fx = db().prepare("SELECT * FROM fixtures_cache WHERE fixture_id=10").get() as unknown as FixtureRow;
    const ins = await insightsView(fx);
    expect(ins.sameOdds?.n).toBe(2);
    expect(ins.sameOdds?.w).toBe(1);
    expect(ins.sameOdds?.l).toBe(1);
    expect(ins.fatigue.home?.restDays).toBe(3);
    expect(ins.fatigue.home?.next7).toBe(1);
  });

  it("同赔历史按主盘稳定取首帧,不受同时间多书商行序影响", async () => {
    seedFixture(20, -1, 100, 200, 0, 0, "NS");
    seedSnapBook(20, 99, "OtherBook", "eu", null, 9.9, 9.8, 9.7, NOW - DAY); // 先插入但非主源
    seedSnapBook(20, 8, "Bet365", "eu", null, 2.0, 3.6, 3.4, NOW - DAY);

    seedFixture(21, 30, 300, 400, 2, 1);
    seedSnapBook(21, 99, "OtherBook", "eu", null, 8.8, 8.7, 8.6, NOW - 31 * DAY);
    seedSnapBook(21, 8, "Bet365", "eu", null, 2.01, 3.58, 3.42, NOW - 31 * DAY);

    const fx = db().prepare("SELECT * FROM fixtures_cache WHERE fixture_id=20").get() as unknown as FixtureRow;
    const ins = await insightsView(fx);
    expect(ins.sameOdds?.triple).toBe("2.00/3.40/3.60");
    expect(ins.sameOdds?.n).toBe(1);
    expect(ins.sameOdds?.w).toBe(1);
  });
});
