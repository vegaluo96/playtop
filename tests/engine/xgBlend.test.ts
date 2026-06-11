import { describe, expect, it } from "vitest";
import { runEngine } from "@/server/engine";
import type { EngineBundle, EngineParams } from "@/server/engine/types";
import { syntheticLeague } from "./helpers";

const base: EngineParams = {
  xi: 0.0019, rho: -0.05, homeAdvElo: 100, eloK0: 10, eloGoalDiffExp: 1,
  eloCalib: { b: 0.0044, c1: -0.45, c2: 0.55 },
  ensembleWeights: { market: 0.55, dc: 0.3, elo: 0.15 },
  bookWeights: {}, sharpBooks: ["Pinnacle"], xgBlend: 0.5,
  kellyFraction: 0.25, kellyCap: 0.05, evThreshold: 0.03, minProbForPick: 0.3,
  adjustmentsEnabled: false, shotsBlendTheta: 0,
};

describe("xG 融合", () => {
  const league = syntheticLeague(7, 14, 3);
  const computedAt = league.history[league.history.length - 1].playedAt + 86_400_000;
  const mk = (xg?: EngineBundle["xg"]): EngineBundle => ({
    match: { homeTeamId: 100, awayTeamId: 101, kickoffAt: computedAt + 86_400_000 },
    leagueHistory: league.history,
    elo: { home: { rating: 1520, matchesPlayed: 40 }, away: { rating: 1500, matchesPlayed: 40 } },
    xg,
    computedAt,
  });

  it("主队近期 xG 远高于客队 → 集成主胜概率被上抬，trace 记录融合", () => {
    const lowXg = runEngine(mk({ home: { forAvg: 1.0, againstAvg: 1.4, n: 8 }, away: { forAvg: 1.0, againstAvg: 1.4, n: 8 } }), base);
    const highXg = runEngine(mk({ home: { forAvg: 2.2, againstAvg: 0.7, n: 8 }, away: { forAvg: 0.8, againstAvg: 1.8, n: 8 } }), base);
    expect(highXg.ensemble.probs.home).toBeGreaterThan(lowXg.ensemble.probs.home);
    expect(highXg.trace.some((t) => t.includes("xG 融合"))).toBe(true);
  });

  it("样本不足（n<3）或关闭（θ=0）时跳过", () => {
    const skipN = runEngine(mk({ home: { forAvg: 2.2, againstAvg: 0.7, n: 2 }, away: { forAvg: 0.8, againstAvg: 1.8, n: 2 } }), base);
    expect(skipN.trace.some((t) => t.includes("xG 融合"))).toBe(false);
    const off = runEngine(mk({ home: { forAvg: 2.2, againstAvg: 0.7, n: 8 }, away: { forAvg: 0.8, againstAvg: 1.8, n: 8 } }), { ...base, xgBlend: 0 });
    expect(off.trace.some((t) => t.includes("xG 融合"))).toBe(false);
  });

  it("无 xG 数据时输出与基线一致（golden 不受影响）", () => {
    const a = runEngine(mk(undefined), base);
    const b = runEngine(mk(undefined), base);
    expect(a.ensemble.probs).toEqual(b.ensemble.probs);
  });
});
