import type { ThreeWay } from "./types";

/**
 * 比分矩阵 → 衍生市场（1X2 / 大小球 / 亚盘）与结算语义。
 * 结算函数与概率函数共用同一套盘口语义，保证"预测命中判定"与"建模口径"一致。
 */

/** 整体重标定：缩放主胜/平/客胜三个区域，使矩阵 1X2 边际等于集成概率 */
export function rescaleMatrixTo1x2(matrix: number[][], target: ThreeWay): number[][] {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let x = 0; x < matrix.length; x++) {
    for (let y = 0; y < matrix[x].length; y++) {
      if (x > y) home += matrix[x][y];
      else if (x === y) draw += matrix[x][y];
      else away += matrix[x][y];
    }
  }
  const fH = home > 0 ? target.home / home : 0;
  const fD = draw > 0 ? target.draw / draw : 0;
  const fA = away > 0 ? target.away / away : 0;
  return matrix.map((row, x) =>
    row.map((p, y) => (x > y ? p * fH : x === y ? p * fD : p * fA)),
  );
}

export interface OuProbs {
  over: number;
  under: number;
  push: number;
}

export function ouProbs(matrix: number[][], line: number): OuProbs {
  let over = 0;
  let under = 0;
  let push = 0;
  for (let x = 0; x < matrix.length; x++) {
    for (let y = 0; y < matrix[x].length; y++) {
      const total = x + y;
      if (total > line) over += matrix[x][y];
      else if (total < line) under += matrix[x][y];
      else push += matrix[x][y];
    }
  }
  return { over, under, push };
}

/** 亚盘四分之一盘拆成两个半注（如 -0.25 → [0, -0.5]） */
export function decomposeAhLine(line: number): number[] {
  const quarters = Math.round(line * 4);
  if (quarters % 2 === 0) return [line];
  return [(quarters - 1) / 4, (quarters + 1) / 4];
}

export interface LegProbs {
  win: number;
  push: number;
  lose: number;
}

/** 主队让 line 球后的单腿胜负概率（M = 主队净胜球，主队赢盘条件 M + line > 0） */
export function ahLegProbs(matrix: number[][], leg: number): LegProbs {
  let win = 0;
  let push = 0;
  let lose = 0;
  for (let x = 0; x < matrix.length; x++) {
    for (let y = 0; y < matrix[x].length; y++) {
      const adj = x - y + leg;
      if (adj > 1e-9) win += matrix[x][y];
      else if (adj < -1e-9) lose += matrix[x][y];
      else push += matrix[x][y];
    }
  }
  return { win, push, lose };
}

/** 主队覆盖（赢盘）概率，push 按半计；四分盘取两腿平均 */
export function ahHomeCover(matrix: number[][], line: number): number {
  const legs = decomposeAhLine(line);
  let sum = 0;
  for (const leg of legs) {
    const p = ahLegProbs(matrix, leg);
    sum += p.win + 0.5 * p.push;
  }
  return sum / legs.length;
}

/** 亚盘 EV（单位本金；四分盘两腿各半注）：side='home' 时使用主队赔率 o */
export function ahEv(matrix: number[][], line: number, side: "home" | "away", odds: number): number {
  const legs = decomposeAhLine(line);
  let ev = 0;
  for (const leg of legs) {
    const p = ahLegProbs(matrix, leg);
    const win = side === "home" ? p.win : p.lose;
    const lose = side === "home" ? p.lose : p.win;
    ev += (win * (odds - 1) - lose) / legs.length;
  }
  return ev;
}

/** 大小球 EV（整数盘可能走水） */
export function ouEv(matrix: number[][], line: number, side: "over" | "under", odds: number): number {
  const p = ouProbs(matrix, line);
  const win = side === "over" ? p.over : p.under;
  const lose = side === "over" ? p.under : p.over;
  return win * (odds - 1) - lose;
}

export type SettleResult = "hit" | "miss" | "push";

/** 1X2 结算 */
export function settle1x2(homeGoals: number, awayGoals: number, selection: string): SettleResult {
  const actual = homeGoals > awayGoals ? "home" : homeGoals === awayGoals ? "draw" : "away";
  return actual === selection ? "hit" : "miss";
}

/** 大小球结算（整数盘恰好等于 line 时走水） */
export function settleOu(totalGoals: number, line: number, side: "over" | "under"): SettleResult {
  if (Math.abs(totalGoals - line) < 1e-9) return "push";
  const overHit = totalGoals > line;
  return (side === "over") === overHit ? "hit" : "miss";
}

/**
 * 亚盘结算。margin = 主队净胜球；line 为主队让球（主让半球 = -0.5）。
 * 四分盘两腿合并：赢半计 hit，输半计 miss，双腿走水计 push（战绩口径在战绩页明示）。
 */
export function settleAh(margin: number, line: number, side: "home" | "away"): SettleResult {
  const legs = decomposeAhLine(line);
  let score = 0; // 每腿：赢 +1，输 -1，走水 0
  for (const leg of legs) {
    const adj = margin + leg;
    const homeLeg = adj > 1e-9 ? 1 : adj < -1e-9 ? -1 : 0;
    score += side === "home" ? homeLeg : -homeLeg;
  }
  if (score > 0) return "hit";
  if (score < 0) return "miss";
  return "push";
}

export function topScores(matrix: number[][], n: number): { score: string; prob: number }[] {
  const flat: { score: string; prob: number }[] = [];
  for (let x = 0; x < matrix.length; x++) {
    for (let y = 0; y < matrix[x].length; y++) {
      flat.push({ score: `${x}-${y}`, prob: matrix[x][y] });
    }
  }
  return flat.sort((a, b) => b.prob - a.prob).slice(0, n);
}
