import { describe, expect, it } from "vitest";
import { logOpinionPool } from "@/server/engine/ensemble";
import { kellyStake, expectedValue } from "@/server/engine/kelly";

describe("对数意见池", () => {
  const a = { home: 0.5, draw: 0.3, away: 0.2 };
  const b = { home: 0.4, draw: 0.3, away: 0.3 };

  it("权重 {1,0,0} 退化为单模型", () => {
    const r = logOpinionPool([
      { probs: a, weight: 1 },
      { probs: b, weight: 0 },
    ]);
    expect(r.probs.home).toBeCloseTo(a.home, 9);
    expect(r.probs.away).toBeCloseTo(a.away, 9);
  });

  it("缺席成员权重摊给在场成员", () => {
    const r = logOpinionPool([
      { probs: a, weight: 0.5 },
      { probs: null, weight: 0.3 },
      { probs: b, weight: 0.2 },
    ]);
    expect(r.probs.home + r.probs.draw + r.probs.away).toBeCloseTo(1, 9);
    expect(r.effectiveWeights[0]).toBeCloseTo(0.5 / 0.7, 9);
    expect(r.effectiveWeights[1]).toBe(0);
    // 几何插值介于两成员之间
    expect(r.probs.home).toBeGreaterThan(b.home);
    expect(r.probs.home).toBeLessThan(a.home);
  });

  it("全缺席时输出均匀分布", () => {
    const r = logOpinionPool([{ probs: null, weight: 1 }]);
    expect(r.probs.home).toBeCloseTo(1 / 3, 9);
  });
});

describe("Kelly", () => {
  it("负 EV → 0 仓位", () => {
    expect(kellyStake(0.4, 2.0, 0.25, 0.05)).toBe(0);
    expect(expectedValue(0.4, 2.0)).toBeCloseTo(-0.2, 9);
  });
  it("黄金值：p=0.5 @2.2 → f*=1/12，四分之一 Kelly", () => {
    // f* = (0.5·2.2 − 1)/1.2 = 0.0833…
    expect(kellyStake(0.5, 2.2, 0.25, 0.05)).toBeCloseTo(0.0833333 / 4, 5);
  });
  it("上限封顶", () => {
    expect(kellyStake(0.9, 2.0, 0.25, 0.05)).toBe(0.05);
  });
});
