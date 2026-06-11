import { describe, expect, it } from "vitest";
import { runEngine } from "@/server/engine";
import type { EngineBundle, EngineParams } from "@/server/engine/types";

const params: EngineParams = {
  xi: 0.0019,
  rho: -0.05,
  homeAdvElo: 100,
  eloK0: 10,
  eloGoalDiffExp: 1,
  eloCalib: { b: 0.0044, c1: -0.45, c2: 0.55 },
  ensembleWeights: { market: 0.55, dc: 0.3, elo: 0.15 },
  bookWeights: {},
  sharpBooks: ["Pinnacle", "Smarkets（交易所）"],
  kellyFraction: 0.25,
  kellyCap: 0.05,
  evThreshold: 0.03,
  minProbForPick: 0.3,
  adjustmentsEnabled: true,
  shotsBlendTheta: 0.35,
};

const T = Date.UTC(2026, 5, 11);

function bundleWith(books: EngineBundle["books"]): EngineBundle {
  return {
    match: { homeTeamId: 1, awayTeamId: 2, kickoffAt: T + 86_400_000 },
    books,
    leagueHistory: [],
    computedAt: T,
  };
}

describe("价差监测：锐价真值锚 + 滞后偏离 + 失效指数", () => {
  it("有锐价时锚定锐价；软盘高报价方向被标为正偏离（滞后让利）", () => {
    const out = runEngine(
      bundleWith([
        { bookmaker: "Pinnacle", oneXTwo: { home: 2.0, draw: 3.5, away: 4.0 }, ou: [], ah: [], capturedAt: T },
        // 软盘主胜明显高于锐价口径 → 正偏离
        { bookmaker: "慢盘甲", oneXTwo: { home: 2.3, draw: 3.4, away: 3.8 }, ou: [], ah: [], capturedAt: T },
      ]),
      params,
    );
    expect(out.spread).not.toBeNull();
    expect(out.spread!.anchor.source).toBe("sharp");
    expect(out.spread!.anchor.books).toEqual(["Pinnacle"]);
    const top = out.spread!.deviations[0];
    expect(top.bookmaker).toBe("慢盘甲");
    expect(top.selection).toBe("home");
    expect(top.deviationPct).toBeGreaterThan(0.05);
    // 锚定概率自洽
    const p = out.spread!.anchor.probs;
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 6);
  });

  it("跨家最优组合隐含概率 <1 时标记定价失效现象", () => {
    const out = runEngine(
      bundleWith([
        { bookmaker: "Pinnacle", oneXTwo: { home: 2.2, draw: 3.6, away: 4.0 }, ou: [], ah: [], capturedAt: T },
        { bookmaker: "慢盘甲", oneXTwo: { home: 2.0, draw: 3.9, away: 4.6 }, ou: [], ah: [], capturedAt: T },
      ]),
      params,
    );
    // 最优价组合：2.2 / 3.9 / 4.6 → Σ1/odds ≈ 0.9285 < 1
    expect(out.spread!.inefficiencyIndex).not.toBeNull();
    expect(out.spread!.inefficiencyIndex!).toBeLessThan(1);
    expect(out.trace.some((t) => t.includes("定价失效"))).toBe(true);
  });

  it("无锐价时回落到加权共识锚；模拟盘不进偏离表", () => {
    const out = runEngine(
      bundleWith([
        { bookmaker: "慢盘甲", oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 }, ou: [], ah: [], capturedAt: T },
        { bookmaker: "参考盘", oneXTwo: { home: 2.6, draw: 3.2, away: 3.0 }, ou: [], ah: [], indicative: true, capturedAt: T },
      ]),
      params,
    );
    expect(out.spread!.anchor.source).toBe("consensus");
    expect(out.spread!.deviations.every((d) => d.bookmaker !== "参考盘")).toBe(true);
  });

  it("无盘口时 spread 为 null", () => {
    const out = runEngine(bundleWith([]), params);
    expect(out.spread).toBeNull();
  });
});
