import { dcScoreMatrix } from "@/server/engine/dixonColes";
import type { HistMatch } from "@/server/engine/types";

/** 测试专用确定性 RNG（引擎本体无随机；这里只为生成合成数据） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按 DC 联合分布抽样一场比分 */
export function sampleScore(
  lambda: number,
  mu: number,
  rho: number,
  rand: () => number,
): { hg: number; ag: number } {
  const m = dcScoreMatrix(lambda, mu, rho);
  let u = rand();
  for (let x = 0; x < m.length; x++) {
    for (let y = 0; y < m[x].length; y++) {
      u -= m[x][y];
      if (u <= 0) return { hg: x, ag: y };
    }
  }
  return { hg: 0, ag: 0 };
}

export interface SyntheticLeague {
  history: HistMatch[];
  attack: number[];
  defense: number[];
  gamma: number;
  rho: number;
  nTeams: number;
}

/** 已知参数的合成联赛：n 队 × rounds 个双循环 */
export function syntheticLeague(seed: number, nTeams = 20, rounds = 4): SyntheticLeague {
  const rand = mulberry32(seed);
  const gamma = 1.35;
  const rho = -0.05;
  const attack: number[] = [];
  const defense: number[] = [];
  for (let i = 0; i < nTeams; i++) {
    attack.push(Math.exp((rand() - 0.5) * 0.6));
    defense.push(Math.exp((rand() - 0.5) * 0.6));
  }
  // 规范化 mean(log α)=0，与拟合的可识别性约束一致
  const meanLogA = attack.reduce((s, v) => s + Math.log(v), 0) / nTeams;
  for (let i = 0; i < nTeams; i++) {
    attack[i] /= Math.exp(meanLogA);
    defense[i] *= Math.exp(meanLogA);
  }
  // 让进球率落在足球典型水平（联赛场均 ~2.6 球）
  const base = Math.sqrt(1.15);
  const att = attack.map((v) => v * base);
  const def = defense.map((v) => v * base);

  const history: HistMatch[] = [];
  const t0 = Date.UTC(2025, 7, 1);
  let k = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < nTeams; i++) {
      for (let j = 0; j < nTeams; j++) {
        if (i === j) continue;
        const lambda = att[i] * def[j] * gamma;
        const mu = att[j] * def[i];
        const { hg, ag } = sampleScore(lambda, mu, rho, rand);
        history.push({
          homeTeamId: 100 + i,
          awayTeamId: 100 + j,
          homeGoals: hg,
          awayGoals: ag,
          playedAt: t0 + k * 86_400_000 * 0.5,
        });
        k++;
      }
    }
  }
  return { history, attack: att, defense: def, gamma, rho, nTeams };
}
