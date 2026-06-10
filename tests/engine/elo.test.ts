import { describe, expect, it } from "vitest";
import { eloToProbs, expectedScore, fitOrderedLogit, updateElo } from "@/server/engine/elo";
import { mulberry32 } from "./helpers";

describe("Elo 更新（Hvattum & Arntzen 2010）", () => {
  it("黄金值：1500 vs 1500，HA=100，主队 2:0", () => {
    // E_H = 1/(1+10^(-100/400)) = 0.6400649998...
    const e = expectedScore(1500, 1500, 100);
    expect(e).toBeCloseTo(0.640065, 6);
    // k = 10·(1+2)^1 = 30；Δ = 30·(1−0.640065) = 10.79805
    const r = updateElo(1500, 1500, 2, 0, { k0: 10, goalDiffExp: 1, homeAdv: 100 });
    expect(r.home).toBeCloseTo(1510.798, 3);
    expect(r.away).toBeCloseTo(1489.202, 3);
  });

  it("平局时强队失分、零和", () => {
    const r = updateElo(1600, 1400, 1, 1, { k0: 10, goalDiffExp: 1, homeAdv: 100 });
    expect(r.home).toBeLessThan(1600);
    expect(r.home + r.away).toBeCloseTo(3000, 9);
  });
});

describe("有序 logit 概率映射", () => {
  const calib = { b: 0.0044, c1: -0.45, c2: 0.55 };
  it("概率和为 1，主胜概率随 d 单调上升", () => {
    let prev = 0;
    for (const d of [-300, -100, 0, 100, 300]) {
      const p = eloToProbs(d, calib);
      expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
      expect(p.home).toBeGreaterThan(prev);
      prev = p.home;
    }
  });

  it("d=100（含主场分）时概率量级符合足球常态", () => {
    const p = eloToProbs(100, calib);
    expect(p.home).toBeGreaterThan(0.4);
    expect(p.home).toBeLessThan(0.55);
    expect(p.draw).toBeGreaterThan(0.18);
    expect(p.draw).toBeLessThan(0.32);
  });
});

describe("有序 logit 系数拟合", () => {
  it("从已知系数生成样本可恢复概率面", () => {
    const truth = { b: 0.0044, c1: -0.45, c2: 0.55 };
    const rand = mulberry32(99);
    const samples: { d: number; outcome: 0 | 1 | 2 }[] = [];
    for (let i = 0; i < 4000; i++) {
      const d = (rand() - 0.5) * 600;
      const p = eloToProbs(d, truth);
      const u = rand();
      const outcome = u < p.away ? 0 : u < p.away + p.draw ? 1 : 2;
      samples.push({ d, outcome: outcome as 0 | 1 | 2 });
    }
    const fit = fitOrderedLogit(samples, { b: 0.003, c1: -0.3, c2: 0.4 });
    for (const d of [-200, 0, 200]) {
      const pT = eloToProbs(d, truth);
      const pF = eloToProbs(d, fit);
      expect(Math.abs(pT.home - pF.home)).toBeLessThan(0.03);
      expect(Math.abs(pT.draw - pF.draw)).toBeLessThan(0.03);
    }
  }, 20_000);
});
