import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import { marketOverview, marketOverviewBatchBefore, publicMarketOverview } from "../../src/server/markets/overview";

beforeEach(() => {
  _resetDbForTest();
});

function insertSnap(
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

describe("marketOverview", () => {
  it("输出同一套质量门禁后的核心三盘结果", () => {
    insertSnap(1, 99, "SmallBook", "ah", 0.5, 0.9, 0.96, null, 1000);
    insertSnap(1, 8, "Bet365", "ah", 0.5, 0.88, 0.98, null, 2000);
    insertSnap(1, 8, "Bet365", "ou", 2.5, 0.92, 0.94, null, 2100);
    insertSnap(1, 8, "Bet365", "eu", null, 1.8, 3.6, 4.5, 2200);
    insertSnap(1, 7, "BadBook", "ou", 20, 0.9, 0.96, null, 2300);

    const overview = marketOverview(1);

    expect(overview.odds.ah.at(-1)).toMatchObject({ bookmaker: "主流共识", line: 0.5, h: 0.89, a: 0.97 });
    expect(overview.odds.ou.at(-1)).toMatchObject({ bookmaker: "主流共识", line: 2.5 });
    expect(overview.odds.eu.at(-1)).toMatchObject({ bookmaker: "主流共识", h: 1.8 });
    expect(overview.odds.compareOu.some((row) => row.bookmaker === "BadBook")).toBe(false);
    expect(overview.dataQualityScore).toBeGreaterThanOrEqual(70);
    expect(overview.selectedReasons.ah).toContain("共识线");
  });

  it("cutoffAt 锁定开赛前最后一版", () => {
    insertSnap(2, 8, "Bet365", "ah", -0.5, 0.9, 0.96, null, 1000);
    insertSnap(2, 8, "Bet365", "ah", 1.5, 0.8, 1.05, null, 3000);

    const overview = marketOverview(2, { cutoffAt: 2000 });

    expect(overview.odds.ah.at(-1)?.line).toBe(-0.5);
    expect(overview.cutoffAt).toBe(2000);
  });

  it("公开口径只返回质量与原因,不泄露原始书商名", () => {
    insertSnap(3, 8, "Bet365", "ah", 0.5, 0.88, 0.98, null, 1000);
    insertSnap(3, 4, "平博", "ou", 2.5, 0.9, 0.96, null, 1100);
    insertSnap(3, 8, "Bet365", "eu", null, 1.9, 3.4, 4.2, 1200);

    const pub = publicMarketOverview(marketOverview(3));
    const text = JSON.stringify(pub);

    expect(pub?.selectedReasons.ah).toContain("覆盖");
    expect(text).not.toContain("Bet365");
    expect(text).not.toContain("平博");
  });

  it("批量截止版复用同一主盘口选择口径", () => {
    insertSnap(4, 8, "Bet365", "ah", -0.5, 0.9, 0.96, null, 1000);
    insertSnap(4, 8, "Bet365", "ah", 1.5, 0.8, 1.05, null, 3000);

    const batch = marketOverviewBatchBefore([4], new Map([[4, 2000]]));

    expect(batch.get(4)?.odds.ah.at(-1)?.line).toBe(-0.5);
    expect(batch.get(4)?.cutoffAt).toBe(2000);
  });
});
