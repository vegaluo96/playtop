/** 综合指数:共识盘口中位数 + 净水中位数;不足回退;滚球段直读;变盘标记 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import { compositeLive, compositePre, mergeComposite } from "../../src/server/views/composite";
import { archiveLiveOdds } from "../../src/server/af/live-store";

function snap(book: string, line: number, h: number, at: number, fid = 9) {
  db().prepare(
    "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(fid, 1, book, "ah", line, h, 0.95, null, at);
}

beforeEach(() => {
  _resetDbForTest();
  db();
});

describe("compositePre", () => {
  const t = 1_000_000;

  it("共识盘口=各家中位数,指数=共识盘口下净水中位数", () => {
    snap("A", 0.5, 0.9, t);
    snap("B", 0.5, 0.94, t + 1_000);
    snap("C", 0.5, 0.98, t + 2_000);
    snap("D", 0.75, 0.7, t + 3_000); // 离群盘口不进指数
    const r = compositePre(9, "ah", t + 3_600_000);
    expect(r.books).toBe(4);
    const last = r.points[r.points.length - 1];
    expect(last.line).toBe(0.5);
    expect(last.v).toBe(0.94); // A/B/C 中位数
    expect(last.n).toBe(4);
  });

  it("共识家数不足 3 时回退全体净水中位数", () => {
    snap("A", 0.5, 0.9, t);
    snap("B", 0.75, 0.96, t + 1_000);
    const r = compositePre(9, "ah", t + 3_600_000);
    const last = r.points[r.points.length - 1];
    expect(last.v).toBeCloseTo(0.93, 3); // (0.9+0.96)/2
  });

  it("书商最后值前推:后续桶仍包含早先报价的书商", () => {
    snap("A", 0.5, 0.9, t);
    snap("B", 0.5, 0.94, t + 20 * 60_000); // 20 分钟后 B 报价
    const r = compositePre(9, "ah", t + 3_600_000);
    const last = r.points[r.points.length - 1];
    expect(last.n).toBe(2); // A 前推仍在场
  });

  it("空数据返回空点集", () => {
    expect(compositePre(9, "ah", t).points).toEqual([]);
  });
});

describe("compositeLive + mergeComposite", () => {
  it("滚球段直读实时帧;盘口变化生成 markers", () => {
    const t = 2_000_000;
    archiveLiveOdds(9, [{ market: "ah", line: 0.5, h: 0.9, a: 0.96, d: null, suspended: false }], t);
    archiveLiveOdds(9, [{ market: "ah", line: 0.25, h: 0.95, a: 0.91, d: null, suspended: false }], t + 120_000);
    const liveSeg = compositeLive(9, "ah");
    expect(liveSeg).toHaveLength(2);
    expect(liveSeg[0].phase).toBe("live");
    const merged = mergeComposite({ points: [], books: 0 }, liveSeg, "ah");
    expect(merged.markers).toHaveLength(1); // 0.5 → 0.25 变盘
    expect(merged.method).toContain("实时盘");
  });

  it("滚球胜平负指数过滤极端实时帧", () => {
    const t = 3_000_000;
    archiveLiveOdds(9, [{ market: "eu", line: null, h: 6.5, d: 3, a: 1.73, suspended: false }], t);
    archiveLiveOdds(9, [{ market: "eu", line: null, h: 251, d: 9.5, a: 1.05, suspended: false }], t + 120_000);

    const liveSeg = compositeLive(9, "eu");

    expect(liveSeg).toHaveLength(1);
    expect(liveSeg[0].t).toBe(t);
  });
});
