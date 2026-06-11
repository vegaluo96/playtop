import { describe, expect, it } from "vitest";
import { runEngine } from "@/server/engine";
import type { EngineBundle, EngineParams } from "@/server/engine/types";

const params: EngineParams = {
  rho: -0.05,
  bookWeights: {}, sharpBooks: ["Pinnacle"], afWeight: 0.7,
  kellyFraction: 0.25, kellyCap: 0.05, evThreshold: 0.03, minProbForPick: 0.3,
  adjustmentsEnabled: false,
};
const T = Date.UTC(2026, 5, 12);

describe("AF 蒸馏预测主导引擎", () => {
  it("AF 预测存在 → 主导集成(权重高)，集成自建分量恒为 0，afModel 落盘", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 1, awayTeamId: 2, kickoffAt: T + 86_400_000 },
      books: [{ bookmaker: "Pinnacle", oneXTwo: { home: 2.0, draw: 3.5, away: 4.0 }, ou: [], ah: [], capturedAt: T }],
      afPrediction: { home: 0.6, draw: 0.25, away: 0.15, expGoalsHome: 1.9, expGoalsAway: 0.9, advice: "Winner: Home" },
      computedAt: T,
    };
    const out = runEngine(bundle, params);
    expect(out.afModel).not.toBeNull();
    expect(out.afModel!.weight).toBeGreaterThan(0.6); // AF 主导
    expect(out.ensemble.weights.dc).toBe(0); // 自建统计已移除
    expect(out.ensemble.weights.elo).toBe(0);
    // AF 期望进球驱动比分矩阵 → 有亚盘/大小球派生
    expect(out.dixonColes).not.toBeNull();
    expect(out.trace.some((t) => t.includes("AF 预测期望进球"))).toBe(true);
    // 集成偏向 AF 的主胜（0.6）而非市场去水
    expect(out.ensemble.probs.home).toBeGreaterThan(0.5);
  });

  it("无 AF 预测 → 回落市场共识，afModel 为 null", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 1, awayTeamId: 2, kickoffAt: T + 86_400_000 },
      books: [{ bookmaker: "Pinnacle", oneXTwo: { home: 2.0, draw: 3.5, away: 4.0 }, ou: [], ah: [], capturedAt: T }],
      computedAt: T,
    };
    const out = runEngine(bundle, params);
    expect(out.afModel).toBeNull();
    expect(out.ensemble.weights.market).toBeGreaterThan(0); // 市场仍在
  });

  it("AF 仅有概率无期望进球 → 仍主导 1X2，矩阵走市场反推", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 1, awayTeamId: 2, kickoffAt: T + 86_400_000 },
      books: [{ bookmaker: "Pinnacle", oneXTwo: { home: 2.0, draw: 3.5, away: 4.0 }, ou: [{ line: 2.5, over: 1.9, under: 1.9 }], ah: [], capturedAt: T }],
      afPrediction: { home: 0.55, draw: 0.27, away: 0.18, expGoalsHome: null, expGoalsAway: null, advice: null },
      computedAt: T,
    };
    const out = runEngine(bundle, params);
    expect(out.afModel).not.toBeNull();
    expect(out.afModel!.expGoalsHome).toBeNull();
    expect(out.ensemble.probs.home).toBeGreaterThan(0.45);
  });
});
