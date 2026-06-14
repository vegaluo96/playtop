/** 历史报价:盘前+滚球帧合并、最新在上、变盘标记、滚球标记、500 封顶 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import { quoteHistory } from "../../src/server/views/history";

beforeEach(() => _resetDbForTest());

const KICK = 1_900_000_000_000;

function seedFx(status = "2H") {
  db().prepare(
    `INSERT INTO fixtures_cache (fixture_id, league_id, season, league_name, round, kickoff_utc, status, home_id, home_name, away_id, away_name, goals_home, goals_away, payload, updated_at)
     VALUES (9,39,2025,'PL','1',?,?,100,'A',200,'B',1,0,'{}',0)`,
  ).run(KICK, status);
}
function seedSnap(line: number, h: number, a: number, at: number) {
  db().prepare(
    "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (9,8,'Bet365','ah',?,?,?,NULL,?)",
  ).run(line, h, a, at);
}
function seedLive(line: number, h: number, a: number, at: number) {
  db().prepare(
    "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (9,'ah',?,?,?,NULL,0,?)",
  ).run(line, h, a, at);
}
function seedLiveEu(h: number, d: number, a: number, at: number) {
  db().prepare(
    "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (9,'eu',NULL,?,?,?,?,?)",
  ).run(h, a, d, 0, at);
}

describe("quoteHistory", () => {
  it("盘前+滚球合并,最新在上,变盘行打标,滚球帧带标", () => {
    seedFx();
    seedSnap(0.5, 0.9, 0.96, KICK - 7_200_000);
    seedSnap(0.75, 0.85, 1.0, KICK - 3_600_000); // 变盘
    seedLive(0.25, 0.92, 0.94, KICK + 600_000);
    const v = quoteHistory(9, "ah", "UTC+8")!;
    expect(v.n).toBe(3);
    expect(v.rows[0].live).toBe(true); // 最新 = 滚球帧
    expect(v.rows[0].chg).toBe(true); // 0.75 → 0.25 变盘
    expect(v.rows[1].chg).toBe(true); // 0.5 → 0.75 变盘
    expect(v.rows[2].chg).toBe(false); // 首帧不算变盘
    expect(v.rows[2].text).toBe("半球");
    expect(v.src).toBe("主流共识");
  });

  it("未开赛不并滚球帧;比赛不存在返回 null;500 帧封顶", () => {
    seedFx("NS");
    seedLive(0.5, 0.9, 0.96, KICK + 60_000); // 异常残留帧,未开赛不应出现
    for (let i = 0; i < 520; i++) seedSnap(0.5, 0.9 + (i % 3) * 0.01, 0.96, KICK - 10_000_000 + i * 10_000);
    const v = quoteHistory(9, "ah", "UTC+8")!;
    expect(v.n).toBe(520);
    expect(v.rows).toHaveLength(500);
    expect(v.rows.every((r) => !r.live)).toBe(true);
    expect(quoteHistory(404, "ah", "UTC+8")).toBeNull();
  });

  it("胜平负最新滚球脏帧时隐藏滚球段,不回退展示上一条实时盘", () => {
    seedFx();
    db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (9,8,'Bet365','eu',NULL,?,?,?,?)",
    ).run(1.8, 4.5, 3.6, KICK - 7_200_000);
    seedLiveEu(6.5, 3, 1.73, KICK + 300_000);
    seedLiveEu(251, 9.5, 1.05, KICK + 600_000);

    const v = quoteHistory(9, "eu", "UTC+8")!;

    expect(v.rows.some((r) => r.h === "251.00")).toBe(false);
    expect(v.rows.some((r) => r.h === "6.50")).toBe(false);
    expect(v.rows[0].h).toBe("1.80");
    expect(v.rows[0].live).toBe(false);
  });
});
