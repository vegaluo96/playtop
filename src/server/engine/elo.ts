import type { ThreeWay } from "./types";

/**
 * Hvattum & Arntzen (2010), "Using ELO ratings for match result prediction
 * in association football", International Journal of Forecasting 26(3).
 *
 * 进球差调整 Elo：k = k0·(1+δ)^λ，δ 为净胜球绝对值。
 * Elo 差 d（含主场分）经有序 logit 映射为三向概率（同论文做法，
 * 系数由历史样本极大似然估计；冷启动用文献典型值）。
 */

export interface EloUpdateOptions {
  k0: number;
  goalDiffExp: number;
  homeAdv: number;
}

export function expectedScore(rHome: number, rAway: number, homeAdv: number): number {
  return 1 / (1 + Math.pow(10, -(rHome + homeAdv - rAway) / 400));
}

export function updateElo(
  rHome: number,
  rAway: number,
  homeGoals: number,
  awayGoals: number,
  opts: EloUpdateOptions,
): { home: number; away: number } {
  const eH = expectedScore(rHome, rAway, opts.homeAdv);
  const sH = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;
  const delta = Math.abs(homeGoals - awayGoals);
  const k = opts.k0 * Math.pow(1 + delta, opts.goalDiffExp);
  const change = k * (sH - eH);
  return { home: rHome + change, away: rAway - change };
}

export interface OrderedLogitCalib {
  b: number;
  c1: number;
  c2: number;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** d = rHome + homeAdv − rAway（已含主场分） */
export function eloToProbs(d: number, calib: OrderedLogitCalib): ThreeWay {
  const pAwayCum = sigmoid(calib.c1 - calib.b * d);
  const pDrawCum = sigmoid(calib.c2 - calib.b * d);
  return {
    home: 1 - pDrawCum,
    draw: Math.max(0, pDrawCum - pAwayCum),
    away: pAwayCum,
  };
}

/**
 * 有序 logit 系数 MLE（样本：{d, outcome}，outcome: 0=客胜 1=平 2=主胜）。
 * 三参数梯度上升；样本不足时调用方应继续用文献缺省值。
 */
export function fitOrderedLogit(
  samples: { d: number; outcome: 0 | 1 | 2 }[],
  init: OrderedLogitCalib = { b: 0.0044, c1: -0.45, c2: 0.55 },
  maxIter = 2000,
): OrderedLogitCalib & { logLik: number; converged: boolean } {
  let { b, c1, c2 } = init;
  const ll = (bv: number, c1v: number, c2v: number): number => {
    if (c2v <= c1v) return -Infinity;
    let s = 0;
    for (const { d, outcome } of samples) {
      const pA = sigmoid(c1v - bv * d);
      const pD = sigmoid(c2v - bv * d) - pA;
      const pH = 1 - sigmoid(c2v - bv * d);
      const p = outcome === 0 ? pA : outcome === 1 ? pD : pH;
      if (p <= 1e-12) return -Infinity;
      s += Math.log(p);
    }
    return s;
  };
  let cur = ll(b, c1, c2);
  let lr = 1e-3;
  let converged = false;
  const eps = { b: 1e-6, c: 1e-5 };
  for (let i = 0; i < maxIter; i++) {
    // 数值梯度（3 参数，开销可忽略）
    const gb = (ll(b + eps.b, c1, c2) - ll(b - eps.b, c1, c2)) / (2 * eps.b);
    const g1 = (ll(b, c1 + eps.c, c2) - ll(b, c1 - eps.c, c2)) / (2 * eps.c);
    const g2 = (ll(b, c1, c2 + eps.c) - ll(b, c1, c2 - eps.c)) / (2 * eps.c);
    let accepted = false;
    for (let bt = 0; bt < 30; bt++) {
      // b 的量纲远小于 c：按各自梯度归一
      const nb = b + (lr * gb) / (1 + Math.abs(gb)) * 1e-3;
      const n1 = c1 + (lr * g1) / (1 + Math.abs(g1));
      const n2 = c2 + (lr * g2) / (1 + Math.abs(g2));
      const next = ll(nb, n1, n2);
      if (next > cur) {
        const improved = next - cur;
        b = nb;
        c1 = n1;
        c2 = n2;
        cur = next;
        lr = Math.min(0.5, lr * 1.3);
        accepted = true;
        if (improved < 1e-9 * (1 + Math.abs(next))) converged = true;
        break;
      }
      lr /= 2;
    }
    if (!accepted || converged) {
      converged = converged || !accepted;
      break;
    }
  }
  return { b, c1, c2, logLik: cur, converged };
}
