import { describe, expect, it } from "vitest";
import {
  dcScoreMatrix,
  marketInversion,
  matrixToThreeWay,
  poissonPmf,
  tau,
} from "@/server/engine/dixonColes";
import { ouProbs } from "@/server/engine/markets";

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

describe("市场反推（无 AF 期望进球时的退化路径）", () => {
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
