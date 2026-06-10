import type { ThreeWay } from "./types";

/**
 * 赔率隐含概率去水。
 *
 * 三向盘（1X2）默认用 Shin (1993) 方法：将书商溢出建模为内幕交易者比例 z，
 *   p_i = [sqrt(z^2 + 4(1-z)·π_i^2/B) - z] / (2(1-z))，B = Σπ_j，π_i = 1/o_i，
 * 对 z 二分使 Σp_i = 1。Štrumbelj (2014, IJF) 证明其对 1X2 优于直接归一化。
 * 两向盘（大小球/亚盘）用 power 法：求 k 使 Σπ_i^k = 1。
 */

export interface ShinResult {
  probs: ThreeWay;
  overround: number;
  z: number;
}

export function shinDevig(odds: ThreeWay): ShinResult {
  const pi = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const B = pi.home + pi.draw + pi.away;
  const overround = B - 1;
  if (overround <= 0) {
    // 无水位（或套利盘）：直接归一化
    return {
      probs: { home: pi.home / B, draw: pi.draw / B, away: pi.away / B },
      overround,
      z: 0,
    };
  }
  const probsAt = (z: number): ThreeWay => {
    const f = (p: number) => (Math.sqrt(z * z + (4 * (1 - z) * p * p) / B) - z) / (2 * (1 - z));
    return { home: f(pi.home), draw: f(pi.draw), away: f(pi.away) };
  };
  const sumAt = (z: number) => {
    const p = probsAt(z);
    return p.home + p.draw + p.away;
  };
  // z=0 时 Σp = sqrt(B) > 1，Σp 随 z 单调递减 → 二分
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const raw = probsAt(z);
  const s = raw.home + raw.draw + raw.away;
  return {
    probs: { home: raw.home / s, draw: raw.draw / s, away: raw.away / s },
    overround,
    z,
  };
}

/** Power 法去水（任意路数）：p_i = π_i^k，k 使 Σp_i = 1 */
export function powerDevig(oddsList: number[]): number[] {
  const pi = oddsList.map((o) => 1 / o);
  const sum0 = pi.reduce((a, b) => a + b, 0);
  if (sum0 <= 1) return pi.map((p) => p / sum0);
  const sumAt = (k: number) => pi.reduce((a, p) => a + Math.pow(p, k), 0);
  let lo = 1;
  let hi = 50;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const p = pi.map((x) => Math.pow(x, k));
  const s = p.reduce((a, b) => a + b, 0);
  return p.map((x) => x / s);
}

/** 两向盘去水，返回第一腿的公平概率 */
export function twoWayDevig(oddsA: number, oddsB: number): number {
  const [pA] = powerDevig([oddsA, oddsB]);
  return pA;
}
