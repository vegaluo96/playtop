import { describe, expect, it } from "vitest";

import {
  buildOddsFromPolymarket,
  normName,
  parsePolymarketSearch,
  pickEventForMatch,
} from "@/server/datasources/polymarket";

const KICKOFF = Date.UTC(2026, 5, 11, 19, 0);

const SAMPLE = JSON.stringify({
  events: [
    {
      title: "Mexico vs South Africa",
      gameStartTime: "2026-06-11T19:00:00Z",
      markets: [
        {
          question: "Mexico vs South Africa",
          outcomes: '["Mexico","Draw","South Africa"]',
          outcomePrices: '["0.55","0.25","0.18"]',
        },
      ],
    },
    {
      title: "Will Curaçao win the World Cup?",
      startDate: "2026-07-19T19:00:00Z",
      markets: [{ outcomes: '["Yes","No"]', outcomePrices: '["0.01","0.99"]' }],
    },
  ],
});

describe("Polymarket 适配器", () => {
  it("normName：去音调/大小写/符号", () => {
    expect(normName("Curaçao")).toBe("curacao");
    expect(normName("South Africa")).toBe("southafrica");
  });

  it("递归解析 + 事件匹配（队名含匹配 + 开球 ±36h）", () => {
    const events = parsePolymarketSearch(SAMPLE);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const hit = pickEventForMatch(events, {
      homeNames: ["Mexico"],
      awayNames: ["South Africa"],
      kickoffAt: KICKOFF,
    });
    expect(hit).not.toBeNull();
    expect(hit!.outcomes).toHaveLength(3);
    // 时间窗外不匹配
    const miss = pickEventForMatch(events, {
      homeNames: ["Mexico"],
      awayNames: ["South Africa"],
      kickoffAt: KICKOFF + 10 * 86_400_000,
    });
    expect(miss).toBeNull();
  });

  it("价格→赔率：odds = 1/p，三向价格和≈1 才采信", () => {
    const events = parsePolymarketSearch(SAMPLE);
    const hit = pickEventForMatch(events, { homeNames: ["Mexico"], awayNames: ["South Africa"], kickoffAt: KICKOFF })!;
    const payload = buildOddsFromPolymarket(hit, { homeNames: ["Mexico"], awayNames: ["South Africa"] }, 99)!;
    expect(payload.bookmaker).toBe("Polymarket");
    expect(payload.oneXTwo!.home).toBeCloseTo(1 / 0.55, 6);
    expect(payload.oneXTwo!.draw).toBeCloseTo(1 / 0.25, 6);
    expect(payload.capturedAt).toBe(99);
  });

  it("价格和越界（匹配错市场特征）→ 拒收", () => {
    const bad = {
      title: "Mexico vs South Africa",
      startAt: KICKOFF,
      outcomes: [
        { label: "Mexico", price: 0.7 },
        { label: "Draw", price: 0.5 },
        { label: "South Africa", price: 0.3 },
      ],
    };
    expect(buildOddsFromPolymarket(bad, { homeNames: ["Mexico"], awayNames: ["South Africa"] }, 0)).toBeNull();
  });

  it("缺平局方向（两向市场）→ 拒收", () => {
    const twoWay = {
      title: "Mexico vs South Africa",
      startAt: KICKOFF,
      outcomes: [
        { label: "Mexico", price: 0.6 },
        { label: "South Africa", price: 0.4 },
      ],
    };
    expect(buildOddsFromPolymarket(twoWay, { homeNames: ["Mexico"], awayNames: ["South Africa"] }, 0)).toBeNull();
  });
});
