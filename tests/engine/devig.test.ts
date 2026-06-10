import { describe, expect, it } from "vitest";
import { powerDevig, shinDevig, twoWayDevig } from "@/server/engine/devig";

describe("shinDevig", () => {
  it("经典算例：2.10/3.40/3.60，水位与归一", () => {
    const r = shinDevig({ home: 2.1, draw: 3.4, away: 3.6 });
    // 隐含概率和 = 0.476190 + 0.294118 + 0.277778 = 1.048086
    expect(r.overround).toBeCloseTo(0.048086, 5);
    expect(r.probs.home + r.probs.draw + r.probs.away).toBeCloseTo(1, 9);
    expect(r.z).toBeGreaterThan(0);
    expect(r.z).toBeLessThan(0.1);
    // 解必须满足 Shin 闭式：p_i = [√(z²+4(1-z)π_i²/B) − z] / (2(1-z))
    const pi = [1 / 2.1, 1 / 3.4, 1 / 3.6];
    const B = pi.reduce((a, b) => a + b, 0);
    const closed = pi.map(
      (p) => (Math.sqrt(r.z * r.z + (4 * (1 - r.z) * p * p) / B) - r.z) / (2 * (1 - r.z)),
    );
    const s = closed.reduce((a, b) => a + b, 0);
    expect(r.probs.home).toBeCloseTo(closed[0] / s, 6);
    expect(r.probs.draw).toBeCloseTo(closed[1] / s, 6);
    expect(r.probs.away).toBeCloseTo(closed[2] / s, 6);
  });

  it("Shin 对热门的偏移大于直接归一化（favourite-longshot 校正方向）", () => {
    const odds = { home: 1.3, draw: 5.0, away: 9.0 };
    const r = shinDevig(odds);
    const pi = { home: 1 / 1.3, draw: 1 / 5.0, away: 1 / 9.0 };
    const B = pi.home + pi.draw + pi.away;
    expect(r.probs.home).toBeGreaterThan(pi.home / B);
    expect(r.probs.away).toBeLessThan(pi.away / B);
  });

  it("无水位时退化为归一化", () => {
    const r = shinDevig({ home: 3, draw: 3, away: 3 });
    expect(r.probs.home).toBeCloseTo(1 / 3, 9);
    expect(r.z).toBe(0);
  });
});

describe("powerDevig / twoWayDevig", () => {
  it("对称两向盘 1.95/1.95 → 0.5", () => {
    expect(twoWayDevig(1.95, 1.95)).toBeCloseTo(0.5, 9);
  });

  it("非对称两向盘归一且热门概率高于直接归一化", () => {
    const [pA, pB] = powerDevig([1.5, 2.5]);
    expect(pA + pB).toBeCloseTo(1, 9);
    const naive = 1 / 1.5 / (1 / 1.5 + 1 / 2.5);
    expect(pA).toBeGreaterThan(naive);
  });

  it("任意合法赔率下概率有效", () => {
    for (const odds of [
      [1.1, 8],
      [2, 2],
      [1.62, 2.3],
    ]) {
      const p = powerDevig(odds);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
      for (const x of p) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(1);
      }
    }
  });
});
