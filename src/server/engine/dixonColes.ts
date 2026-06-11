import type { ThreeWay } from "./types";

/**
 * Dixon & Coles (1997), "Modelling Association Football Scores and
 * Inefficiencies in the Football Betting Market", JRSS Series C 46(2).
 *
 * 主队进球 X ~ Poisson(λ)，客队 Y ~ Poisson(μ)，λ = α_i·β_j·γ，μ = α_j·β_i，
 * 低比分相关性修正 τ 只作用于 {0,1}×{0,1} 四格，且不改变总质量。
 * 参数以时间衰减加权伪似然估计（权重 φ(t)=exp(−ξ·t)，t 为距今天数）。
 */

const MAX_GOALS = 10;

const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800];

export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || k > MAX_GOALS) return 0;
  return Math.exp(-lambda + k * Math.log(lambda)) / FACT[k];
}

/** DC 低比分修正项 τ */
export function tau(x: number, y: number, lambda: number, mu: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** 比分联合概率矩阵 P[x][y]，截断 0..10 后归一化 */
export function dcScoreMatrix(lambda: number, mu: number, rho: number): number[][] {
  const m: number[][] = [];
  let sum = 0;
  for (let x = 0; x <= MAX_GOALS; x++) {
    const row: number[] = [];
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = Math.max(0, tau(x, y, lambda, mu, rho) * poissonPmf(x, lambda) * poissonPmf(y, mu));
      row.push(p);
      sum += p;
    }
    m.push(row);
  }
  return m.map((row) => row.map((p) => p / sum));
}

export function matrixToThreeWay(m: number[][]): ThreeWay {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let x = 0; x < m.length; x++) {
    for (let y = 0; y < m[x].length; y++) {
      if (x > y) home += m[x][y];
      else if (x === y) draw += m[x][y];
      else away += m[x][y];
    }
  }
  return { home, draw, away };
}

function poissonOverProb(total: number, line: number): number {
  const threshold = Math.ceil(line);
  let cdf = 0;
  for (let k = 0; k < threshold; k++) cdf += poissonPmf(k, total);
  return 1 - cdf;
}

/**
 * 市场反推（退化等级 3）：完全由去水概率确定 λ、μ。
 * 总进球 T 由去水大小球概率一维二分（X+Y ~ Pois(λ+μ)，独立泊松和与分割无关）；
 * 主队份额 s 由去水主胜概率二分（固定 T 时 P(主胜) 随 s 单调升）。
 */
export function marketInversion(
  devigged: ThreeWay,
  pOver: number | null,
  overLine: number,
  rho: number,
): { lambda: number; mu: number; note: string } {
  let total: number;
  let note: string;
  if (pOver !== null && pOver > 0.02 && pOver < 0.98) {
    let lo = 0.2;
    let hi = 7;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (poissonOverProb(mid, overLine) < pOver) lo = mid;
      else hi = mid;
    }
    total = (lo + hi) / 2;
    note = `总进球由大小 ${overLine} 盘去水概率反解：T=${total.toFixed(3)}`;
  } else {
    total = 2.6;
    note = "无可用大小球盘，总进球采用联赛典型值 T=2.6";
  }
  let lo = 0.05;
  let hi = 0.95;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const probs = matrixToThreeWay(dcScoreMatrix(total * mid, total * (1 - mid), rho));
    if (probs.home < devigged.home) lo = mid;
    else hi = mid;
  }
  const s = (lo + hi) / 2;
  return { lambda: total * s, mu: total * (1 - s), note };
}
