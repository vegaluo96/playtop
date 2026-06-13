import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import { __polymarketForTest, findPolymarketSignal } from "../../src/server/external/polymarket";

beforeEach(() => {
  _resetDbForTest();
  vi.restoreAllMocks();
});

describe("Polymarket public-search parser", () => {
  it("从足球事件的二元 Yes/No 子市场提取主客概率方向", () => {
    const signal = __polymarketForTest.pickMarket([
      {
        title: "Canada vs. Bosnia-Herzegovina",
        slug: "fifwc-can-bih-2026-06-12",
        active: true,
        closed: false,
        archived: false,
        markets: [
          {
            question: "Will Canada vs. Bosnia and Herzegovina end in a draw?",
            outcomes: "[\"Yes\",\"No\"]",
            outcomePrices: "[\"0.26\",\"0.74\"]",
            active: true,
            closed: false,
          },
          {
            question: "Will Bosnia and Herzegovina win on 2026-06-12?",
            groupItemTitle: "Bosnia-Herzegovina",
            outcomes: "[\"Yes\",\"No\"]",
            outcomePrices: "[\"0.22\",\"0.78\"]",
            active: true,
            closed: false,
          },
          {
            question: "Will Canada win on 2026-06-12?",
            groupItemTitle: "Canada",
            outcomes: "[\"Yes\",\"No\"]",
            outcomePrices: "[\"0.52\",\"0.48\"]",
            active: true,
            closed: false,
          },
        ],
      },
    ], "Canada", "Bosnia & Herzegovina");

    expect(signal).toMatchObject({
      status: "ok",
      side: "home",
      homeProb: 0.52,
      drawProb: 0.26,
      awayProb: 0.22,
    });
  });

  it("忽略已关闭事件,避免赛后 resolved 价格进入预测信号", () => {
    const signal = __polymarketForTest.pickMarket([
      {
        title: "Canada vs. Bosnia-Herzegovina",
        slug: "fifwc-can-bih-2026-06-12",
        active: true,
        closed: true,
        markets: [
          { question: "Will Canada win?", outcomes: "[\"Yes\",\"No\"]", outcomePrices: "[\"1\",\"0\"]" },
        ],
      },
    ], "Canada", "Bosnia & Herzegovina");

    expect(signal.status).toBe("missing");
  });

  it("候选语义不是单场胜平负时进入人工确认,不参与自动拟合", () => {
    const signal = __polymarketForTest.pickMarket([
      {
        title: "Canada vs. Bosnia-Herzegovina",
        slug: "canada-bosnia-advance-2026-06-12",
        active: true,
        closed: false,
        archived: false,
        markets: [
          {
            question: "Will Canada advance to the next round?",
            outcomes: "[\"Yes\",\"No\"]",
            outcomePrices: "[\"0.52\",\"0.48\"]",
            active: true,
            closed: false,
          },
        ],
      },
    ], "Canada", "Bosnia & Herzegovina");

    expect(signal.status).toBe("pendingReview");
    expect(signal.needsReview).toBe(true);
    expect(signal.marketType).toBe("advancement");
    expect(signal.matchScore).toBeGreaterThanOrEqual(48);
  });

  it("搜索无结果时写入逐场诊断,避免 Polymarket missing 静默失败", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200 })));

    const signal = await findPolymarketSignal("Canada", "Bosnia & Herzegovina", {
      fixtureId: 4993253,
      kickoffAt: Date.now() + 3_600_000,
    });

    expect(signal.status).toBe("missing");
    const row = db()
      .prepare("SELECT source, endpoint, fixture_id, error_type, severity FROM diagnostic_issues")
      .get() as { source: string; endpoint: string; fixture_id: number; error_type: string; severity: string };
    expect(row).toEqual({
      source: "POLYMARKET",
      endpoint: "polymarket.gamma",
      fixture_id: 4993253,
      error_type: "POLYMARKET_EMPTY",
      severity: "info",
    });
  });
});
