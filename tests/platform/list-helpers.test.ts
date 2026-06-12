/** 列表页批量取数 helper:与单场盘口选择口径保持一致,并批量返回滚球/异动尾巴。 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import { oddsSeries } from "../../src/server/af/store";
import { liveAwareSeriesBatch, movedRecentlyMap } from "../../src/server/views/list-helpers";

beforeEach(() => {
  _resetDbForTest();
});

function insertOdds(
  fixtureId: number,
  bookmakerId: number,
  bookmaker: string,
  market: "ah" | "ou" | "eu",
  line: number | null,
  h: number,
  a: number,
  d: number | null,
  capturedAt: number,
) {
  db()
    .prepare("INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(fixtureId, bookmakerId, bookmaker, market, line, h, a, d, capturedAt);
}

describe("list helpers", () => {
  it("批量主盘序列与 oddsSeries 单场口径一致", () => {
    insertOdds(1, 8, "Bet365", "ou", 2.25, 0.9, 0.95, null, 1000);
    insertOdds(1, 8, "Bet365", "ou", 2.25, 0.88, 0.97, null, 2000);
    insertOdds(1, 4, "平博", "ou", 2.25, 0.92, 0.93, null, 2100);
    insertOdds(1, 99, "10Bet", "ou", 2.5, 0.86, 0.9, null, 5000);
    insertOdds(2, 4, "平博", "ou", 2.75, 0.91, 0.94, null, 1000);
    insertOdds(2, 8, "Bet365", "ou", 3, 0.87, 0.99, null, 6000);
    insertOdds(2, 99, "10Bet", "ou", 2.75, 0.89, 0.96, null, 7000);

    const batch = liveAwareSeriesBatch([1, 2], "ou", new Set());

    expect(batch.get(1)).toEqual(oddsSeries(1, "ou").slice(-2));
    expect(batch.get(2)).toEqual(oddsSeries(2, "ou").slice(-2));
  });

  it("批量盘口会给滚球场追加最近两个未封盘实时帧", () => {
    insertOdds(10, 8, "Bet365", "ah", 0.5, 0.9, 0.96, null, 1000);
    const ins = db().prepare(
      "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(10, "ah", 0.5, 0.91, 0.95, null, 1, 2000);
    ins.run(10, "ah", 0.5, 0.88, 0.98, null, 0, 2100);
    ins.run(10, "ah", 0.75, 0.86, 1.0, null, 0, 2200);
    ins.run(10, "ah", 0.75, 0.84, 1.02, null, 0, 2300);

    const series = liveAwareSeriesBatch([10], "ah", new Set([10])).get(10);

    expect(series).toHaveLength(3);
    expect(series?.at(-2)).toMatchObject({ bookmaker: "实时盘", line: 0.75, h: 0.86 });
    expect(series?.at(-1)).toMatchObject({ bookmaker: "实时盘", line: 0.75, h: 0.84 });
  });

  it("滚球胜平负最新帧不可信时不回退展示赛前欧盘", () => {
    insertOdds(11, 8, "Bet365", "eu", null, 1.8, 4.5, 3.6, 1000);
    const ins = db().prepare(
      "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(11, "eu", null, 6.5, 1.73, 3, 0, 2000);
    ins.run(11, "eu", null, 251, 1.05, 9.5, 0, 3000);

    const series = liveAwareSeriesBatch([11], "eu", new Set([11])).get(11);

    expect(series).toEqual([]);
  });

  it("滚球亚盘最新帧不可信时不回退展示赛前亚盘", () => {
    insertOdds(13, 8, "Bet365", "ah", 0.5, 0.9, 0.96, null, 1000);
    const ins = db().prepare(
      "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(13, "ah", 12, 0.68, 1.15, null, 0, 2000);

    const series = liveAwareSeriesBatch([13], "ah", new Set([13])).get(13);

    expect(series).toEqual([]);
  });

  it("滚球大小最新帧不可信时不回退展示赛前大小", () => {
    insertOdds(14, 8, "Bet365", "ou", 2.5, 0.9, 0.96, null, 1000);
    const ins = db().prepare(
      "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(14, "ou", 2.5, 40, 0.96, null, 0, 2000);

    const series = liveAwareSeriesBatch([14], "ou", new Set([14])).get(14);

    expect(series).toEqual([]);
  });

  it("滚球胜平负最新帧可信时只追加可信实时帧", () => {
    insertOdds(12, 8, "Bet365", "eu", null, 1.8, 4.5, 3.6, 1000);
    const ins = db().prepare(
      "INSERT INTO live_odds_snapshots (fixture_id, market, line, h, a, d, suspended, captured_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run(12, "eu", null, 51, 1.14, 5, 0, 2000);
    ins.run(12, "eu", null, 6.5, 1.73, 3, 0, 3000);

    const series = liveAwareSeriesBatch([12], "eu", new Set([12])).get(12);

    expect(series?.at(-1)).toMatchObject({ bookmaker: "实时盘", h: 6.5, d: 3, a: 1.73 });
    expect(series?.some((r) => r.h === 51)).toBe(false);
  });

  it("批量异动标记只返回近窗内有记录的场次", () => {
    const now = 1_000_000_000;
    const ins = db().prepare(
      "INSERT INTO movements (fixture_id, market, bookmaker, type, from_line, to_line, from_h, to_h, from_a, to_a, sev, t0, t1) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run(20, "ah", "Bet365", "升盘", 0.25, 0.5, 0.9, 0.86, 0.96, 1.0, 1, now - 3_000, now - 2_000);
    ins.run(21, "ah", "Bet365", "降盘", 0.5, 0.25, 0.88, 0.92, 1.0, 0.95, 1, now - 90_000_000, now - 89_000_000);

    const moved = movedRecentlyMap([20, 21, 22], now - 12 * 3_600_000);

    expect(moved.get(20)).toBe(true);
    expect(moved.get(21)).toBeUndefined();
    expect(moved.get(22)).toBeUndefined();
  });
});
