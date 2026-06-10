import { describe, expect, it } from "vitest";
import {
  blendedGoals,
  chooseDcLevel,
  dcScoreMatrix,
  fitDixonColesMLE,
  fitShotWeights,
  marketInversion,
  matrixToThreeWay,
  momentEstimate,
  poissonPmf,
  tau,
} from "@/server/engine/dixonColes";
import { ouProbs } from "@/server/engine/markets";
import { mulberry32, syntheticLeague } from "./helpers";

describe("tau 修正项（DC 1997 式 4.2）", () => {
  const l = 1.5;
  const m = 1.2;
  const r = -0.05;
  it("五分支精确值", () => {
    expect(tau(0, 0, l, m, r)).toBeCloseTo(1 - 1.5 * 1.2 * -0.05, 12); // 1.09
    expect(tau(0, 1, l, m, r)).toBeCloseTo(1 + 1.5 * -0.05, 12); // 0.925
    expect(tau(1, 0, l, m, r)).toBeCloseTo(1 + 1.2 * -0.05, 12); // 0.94
    expect(tau(1, 1, l, m, r)).toBeCloseTo(1.05, 12);
    expect(tau(2, 3, l, m, r)).toBe(1);
  });
});

describe("比分矩阵", () => {
  it("总质量归一（τ 不改变总质量，截断后归一化）", () => {
    const m = dcScoreMatrix(1.62, 1.18, -0.05);
    const sum = m.flat().reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("三向概率和为 1，且 λ>μ 时主胜概率最高", () => {
    const p = matrixToThreeWay(dcScoreMatrix(1.9, 1.0, -0.05));
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
    expect(p.home).toBeGreaterThan(p.away);
  });

  it("ρ=0 时退化为独立泊松乘积", () => {
    const m = dcScoreMatrix(1.5, 1.2, 0);
    const expected = (poissonPmf(1, 1.5) * poissonPmf(1, 1.2)) / 0.99999;
    expect(m[1][1]).toBeCloseTo(poissonPmf(1, 1.5) * poissonPmf(1, 1.2), 4);
    expect(expected).toBeGreaterThan(0); // 截断损失极小
  });
});

describe("MLE 参数恢复（合成数据）", () => {
  it("已知参数生成 1520 场，拟合误差受控", () => {
    const league = syntheticLeague(42, 20, 4);
    const fit = fitDixonColesMLE(league.history, {
      xi: 0,
      refTime: Date.UTC(2026, 0, 1),
      rhoInit: -0.05,
    });
    expect(fit.converged).toBe(true);
    // γ 相对误差 < 5%
    expect(Math.abs(fit.gamma - league.gamma) / league.gamma).toBeLessThan(0.05);
    // 对位预测的 λ 平均相对误差 < 10%
    let err = 0;
    let n = 0;
    for (let i = 0; i < league.nTeams; i++) {
      for (let j = 0; j < league.nTeams; j++) {
        if (i === j) continue;
        const hi = fit.teamIndex.get(100 + i)!;
        const ai = fit.teamIndex.get(100 + j)!;
        const lambdaFit = fit.attack[hi] * fit.defense[ai] * fit.gamma;
        const lambdaTrue = league.attack[i] * league.defense[j] * league.gamma;
        err += Math.abs(lambdaFit - lambdaTrue) / lambdaTrue;
        n++;
      }
    }
    expect(err / n).toBeLessThan(0.1);
    // ρ 方向正确（负值且在约束内）
    expect(fit.rho).toBeLessThan(0.05);
    expect(fit.rho).toBeGreaterThanOrEqual(-0.15);
  }, 30_000);

  it("时间衰减：xi 大时近期表现主导矩估计", () => {
    const t0 = Date.UTC(2025, 0, 1);
    const day = 86_400_000;
    // 队 1 早期狂胜、近期狂负（对手队 2/3 对称填充）
    const hist = [];
    for (let k = 0; k < 10; k++) {
      hist.push({ homeTeamId: 1, awayTeamId: 2, homeGoals: 4, awayGoals: 0, playedAt: t0 + k * day });
      hist.push({ homeTeamId: 3, awayTeamId: 1, homeGoals: 0, awayGoals: 4, playedAt: t0 + k * day });
    }
    for (let k = 0; k < 10; k++) {
      hist.push({ homeTeamId: 1, awayTeamId: 2, homeGoals: 0, awayGoals: 3, playedAt: t0 + (300 + k) * day });
      hist.push({ homeTeamId: 3, awayTeamId: 1, homeGoals: 3, awayGoals: 0, playedAt: t0 + (300 + k) * day });
    }
    const ref = t0 + 320 * day;
    const flat = momentEstimate(hist, { xi: 0, refTime: ref });
    const decayed = momentEstimate(hist, { xi: 0.02, refTime: ref });
    const idxF = flat.teamIndex.get(1)!;
    const idxD = decayed.teamIndex.get(1)!;
    expect(decayed.attack[idxD]).toBeLessThan(flat.attack[idxF]);
  });
});

describe("市场反推（退化等级 3）", () => {
  it("反推的 λ/μ 复现目标主胜与大小球概率", () => {
    const devigged = { home: 0.45, draw: 0.27, away: 0.28 };
    const inv = marketInversion(devigged, 0.55, 2.5, -0.05);
    const matrix = dcScoreMatrix(inv.lambda, inv.mu, -0.05);
    const p = matrixToThreeWay(matrix);
    expect(p.home).toBeCloseTo(0.45, 3);
    expect(ouProbs(matrix, 2.5).over).toBeCloseTo(0.55, 2);
  });

  it("无大小球盘时采用典型总进球并注明", () => {
    const inv = marketInversion({ home: 0.5, draw: 0.27, away: 0.23 }, null, 2.5, -0.05);
    expect(inv.lambda + inv.mu).toBeCloseTo(2.6, 6);
    expect(inv.note).toContain("典型值");
  });
});

describe("退化链分级", () => {
  it("样本边界", () => {
    const mk = (n: number, teamA = 1, teamB = 2) =>
      Array.from({ length: n }, (_, i) => ({
        homeTeamId: i % 2 === 0 ? teamA : teamB,
        awayTeamId: i % 2 === 0 ? teamB : teamA,
        homeGoals: 1,
        awayGoals: 1,
        playedAt: Date.UTC(2025, 0, 1) + i * 86_400_000,
      }));
    expect(chooseDcLevel(mk(120), 1, 2)).toBe(1);
    expect(chooseDcLevel(mk(50), 1, 2)).toBe(2);
    expect(chooseDcLevel(mk(10), 1, 2)).toBe(3);
    expect(chooseDcLevel(mk(120), 1, 99)).toBe(3); // 参赛队不在样本中
  });
});

describe("射门质量混合", () => {
  it("OLS 权重恢复：伪进球 = 0.05 + 0.02·射门 + 0.25·射正 + 噪声", () => {
    const rand = mulberry32(7);
    const hist = Array.from({ length: 400 }, (_, i) => {
      const hs = Math.floor(rand() * 20) + 2;
      const hst = Math.floor(hs * (0.2 + rand() * 0.3));
      const as = Math.floor(rand() * 20) + 2;
      const ast = Math.floor(as * (0.2 + rand() * 0.3));
      const noise = () => (rand() - 0.5) * 0.8;
      return {
        homeTeamId: (i % 10) + 1,
        awayTeamId: ((i + 3) % 10) + 1,
        homeGoals: Math.max(0, Math.round(0.05 + 0.02 * hs + 0.25 * hst + noise())),
        awayGoals: Math.max(0, Math.round(0.05 + 0.02 * as + 0.25 * ast + noise())),
        playedAt: Date.UTC(2025, 0, 1) + i * 86_400_000,
        homeShots: hs,
        homeSot: hst,
        awayShots: as,
        awaySot: ast,
      };
    });
    const w = fitShotWeights(hist)!;
    expect(w).not.toBeNull();
    expect(w.wSot).toBeGreaterThan(w.wShots); // 射正的信息量必须高于射门
    expect(w.wSot).toBeGreaterThan(0.1);
    const getter = blendedGoals(0.5, w);
    const g = getter(hist[0]);
    expect(g.hg).toBeGreaterThanOrEqual(0);
    // θ=0 等价于真实进球
    const id = blendedGoals(0, w)(hist[0]);
    expect(id.hg).toBeCloseTo(hist[0].homeGoals * 1, 9);
  });
});
