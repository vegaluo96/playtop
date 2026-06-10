import type { ThreeWay } from "./types";

/**
 * 对数意见池（logarithmic opinion pool）：p(i) ∝ Π_m p_m(i)^{w_m}，Σw=1。
 * Genest & Zidek (1986), "Combining Probability Distributions", Statistical Science 1(1).
 * 缺席的模型其权重按比例摊给在场模型。
 */
export function logOpinionPool(
  members: { probs: ThreeWay | null; weight: number }[],
): { probs: ThreeWay; effectiveWeights: number[] } {
  const present = members.filter((m) => m.probs !== null && m.weight > 0);
  const totalW = present.reduce((s, m) => s + m.weight, 0);
  if (present.length === 0 || totalW <= 0) {
    return { probs: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, effectiveWeights: members.map(() => 0) };
  }
  const EPS = 1e-9;
  const logp = { home: 0, draw: 0, away: 0 };
  for (const m of present) {
    const w = m.weight / totalW;
    logp.home += w * Math.log(Math.max(EPS, m.probs!.home));
    logp.draw += w * Math.log(Math.max(EPS, m.probs!.draw));
    logp.away += w * Math.log(Math.max(EPS, m.probs!.away));
  }
  const e = { home: Math.exp(logp.home), draw: Math.exp(logp.draw), away: Math.exp(logp.away) };
  const s = e.home + e.draw + e.away;
  return {
    probs: { home: e.home / s, draw: e.draw / s, away: e.away / s },
    effectiveWeights: members.map((m) =>
      m.probs !== null && m.weight > 0 ? m.weight / totalW : 0,
    ),
  };
}
