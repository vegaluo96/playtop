import { describe, expect, it } from "vitest";
import {
  ahEv,
  ahHomeCover,
  ahLegProbs,
  decomposeAhLine,
  ouEv,
  ouProbs,
  rescaleMatrixTo1x2,
  settle1x2,
  settleAh,
  settleOu,
  topScores,
} from "@/server/engine/markets";
import { dcScoreMatrix } from "@/server/engine/dixonColes";

/** 手工构造稀疏矩阵：P(0,0)=0.2 P(1,0)=0.3 P(0,1)=0.25 P(1,1)=0.25 */
function tinyMatrix(): number[][] {
  const m = Array.from({ length: 11 }, () => new Array(11).fill(0));
  m[0][0] = 0.2;
  m[1][0] = 0.3;
  m[0][1] = 0.25;
  m[1][1] = 0.25;
  return m;
}

describe("亚盘拆腿", () => {
  it("整盘/半盘单腿，四分盘双腿", () => {
    expect(decomposeAhLine(0)).toEqual([0]);
    expect(decomposeAhLine(-0.5)).toEqual([-0.5]);
    expect(decomposeAhLine(-0.25)).toEqual([-0.5, 0]);
    expect(decomposeAhLine(-0.75)).toEqual([-1, -0.5]);
    expect(decomposeAhLine(0.25)).toEqual([0, 0.5]);
  });
});

describe("大小球（黄金值）", () => {
  const m = tinyMatrix();
  it("半球线", () => {
    const p = ouProbs(m, 0.5);
    expect(p.over).toBeCloseTo(0.8, 9);
    expect(p.under).toBeCloseTo(0.2, 9);
    expect(p.push).toBe(0);
  });
  it("整数线走水", () => {
    const p = ouProbs(m, 1);
    expect(p.over).toBeCloseTo(0.25, 9);
    expect(p.under).toBeCloseTo(0.2, 9);
    expect(p.push).toBeCloseTo(0.55, 9);
  });
  it("EV：整数线 push 不贡献盈亏", () => {
    // over@2.0, line=1: EV = 0.25·1 − 0.2 = 0.05
    expect(ouEv(m, 1, "over", 2.0)).toBeCloseTo(0.05, 9);
  });
});

describe("亚盘（黄金值）", () => {
  const m = tinyMatrix();
  it("平手盘单腿概率", () => {
    const p = ahLegProbs(m, 0);
    expect(p.win).toBeCloseTo(0.3, 9); // M>0
    expect(p.push).toBeCloseTo(0.45, 9); // M=0
    expect(p.lose).toBeCloseTo(0.25, 9);
  });
  it("-0.25 覆盖率 = 两腿平均（push 半计）", () => {
    // 腿 -0.5：win=0.3；腿 0：win=0.3+0.45/2=0.525 → (0.3+0.525)/2 = 0.4125
    expect(ahHomeCover(m, -0.25)).toBeCloseTo(0.4125, 9);
  });
  it("-0.25 主队 EV（@2.0）", () => {
    // 腿 -0.5: 0.3·1 − 0.7 = −0.4；腿 0: 0.3·1 − 0.25 = 0.05 → 平均 −0.175
    expect(ahEv(m, -0.25, "home", 2.0)).toBeCloseTo(-0.175, 9);
  });
});

describe("结算语义", () => {
  it("1X2", () => {
    expect(settle1x2(2, 1, "home")).toBe("hit");
    expect(settle1x2(1, 1, "home")).toBe("miss");
    expect(settle1x2(1, 1, "draw")).toBe("hit");
  });
  it("大小球", () => {
    expect(settleOu(3, 2.5, "over")).toBe("hit");
    expect(settleOu(2, 2.5, "over")).toBe("miss");
    expect(settleOu(2, 2, "over")).toBe("push");
    expect(settleOu(1, 2, "under")).toBe("hit");
  });
  it("亚盘：整盘走水、四分盘赢半/输半", () => {
    expect(settleAh(1, -1, "home")).toBe("push"); // 净胜1 让1 → 走水
    expect(settleAh(1, -0.75, "home")).toBe("hit"); // 赢半 → hit
    expect(settleAh(0, -0.25, "home")).toBe("miss"); // 输半 → miss
    expect(settleAh(0, -0.25, "away")).toBe("hit"); // 对面赢半
    expect(settleAh(-1, 0.75, "away")).toBe("hit"); // 客队受让方向
    expect(settleAh(2, -2, "home")).toBe("push");
    expect(settleAh(3, -2, "home")).toBe("hit");
  });
});

describe("矩阵重标定", () => {
  it("重标定后 1X2 边际精确等于目标且总质量为 1", () => {
    const m = dcScoreMatrix(1.6, 1.2, -0.05);
    const target = { home: 0.5, draw: 0.25, away: 0.25 };
    const r = rescaleMatrixTo1x2(m, target);
    let home = 0;
    let draw = 0;
    let away = 0;
    for (let x = 0; x < r.length; x++) {
      for (let y = 0; y < r[x].length; y++) {
        if (x > y) home += r[x][y];
        else if (x === y) draw += r[x][y];
        else away += r[x][y];
      }
    }
    expect(home).toBeCloseTo(0.5, 9);
    expect(draw).toBeCloseTo(0.25, 9);
    expect(away).toBeCloseTo(0.25, 9);
  });
});

describe("topScores", () => {
  it("按概率降序取前 N", () => {
    const t = topScores(tinyMatrix(), 2);
    expect(t[0].score).toBe("1-0");
    expect(t[0].prob).toBeCloseTo(0.3, 9);
    expect(t).toHaveLength(2);
  });
});
