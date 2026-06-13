import { describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { __polymarketForTest } from "../../src/server/external/polymarket";

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
});
