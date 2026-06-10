import type { HistMatch, ThreeWay } from "./types";

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

export interface DcParams {
  teamIndex: Map<number, number>;
  attack: number[]; // α
  defense: number[]; // β
  gamma: number;
  rho: number;
  logLik: number;
  iterations: number;
  converged: boolean;
}

export interface FitOptions {
  xi: number; // 每天衰减
  refTime: number; // 计算时刻（epoch ms），权重基准
  rhoInit?: number;
  maxIter?: number;
  /** 冻结 ρ（射门混合的 quasi-Poisson 拟合需关闭 τ：rhoInit=0 + freezeRho） */
  freezeRho?: boolean;
  /** 响应变量替换（如射门质量混合"伪进球"），缺省用真实进球 */
  goals?: (h: HistMatch) => { hg: number; ag: number };
}

const DAY_MS = 86_400_000;

interface Indexed {
  hi: number;
  ai: number;
  hg: number;
  ag: number;
  w: number;
  /** 1=有主场优势，0=中立场（λ 中 γ 项按此开关） */
  ha: 0 | 1;
}

function indexMatches(hist: HistMatch[], opts: FitOptions): { rows: Indexed[]; teamIndex: Map<number, number> } {
  const teamIndex = new Map<number, number>();
  const idx = (id: number) => {
    if (!teamIndex.has(id)) teamIndex.set(id, teamIndex.size);
    return teamIndex.get(id)!;
  };
  const rows = hist.map((h) => {
    const g = opts.goals ? opts.goals(h) : { hg: h.homeGoals, ag: h.awayGoals };
    return {
      hi: idx(h.homeTeamId),
      ai: idx(h.awayTeamId),
      hg: Math.min(g.hg, MAX_GOALS),
      ag: Math.min(g.ag, MAX_GOALS),
      w: Math.exp((-opts.xi * Math.max(0, opts.refTime - h.playedAt)) / DAY_MS),
      ha: (h.neutral ? 0 : 1) as 0 | 1,
    };
  });
  return { rows, teamIndex };
}

/** 矩估计（退化等级 2）：无需优化器的确定性估计 */
export function momentEstimate(hist: HistMatch[], opts: FitOptions): DcParams {
  const { rows, teamIndex } = indexMatches(hist, opts);
  const n = teamIndex.size;
  const gf = new Array(n).fill(0); // 加权进球
  const ga = new Array(n).fill(0);
  const games = new Array(n).fill(0);
  let wHomeGoals = 0;
  let wAwayGoals = 0;
  let wTotal = 0;
  let haHomeGoals = 0;
  let haAwayGoals = 0;
  let haTotal = 0;
  for (const r of rows) {
    gf[r.hi] += r.w * r.hg;
    ga[r.hi] += r.w * r.ag;
    games[r.hi] += r.w;
    gf[r.ai] += r.w * r.ag;
    ga[r.ai] += r.w * r.hg;
    games[r.ai] += r.w;
    wHomeGoals += r.w * r.hg;
    wAwayGoals += r.w * r.ag;
    wTotal += r.w;
    if (r.ha === 1) {
      haHomeGoals += r.w * r.hg;
      haAwayGoals += r.w * r.ag;
      haTotal += r.w;
    }
  }
  const mHome = wHomeGoals / wTotal;
  const mAway = wAwayGoals / wTotal;
  const mTeam = (mHome + mAway) / 2;
  // γ 只能从有主场优势的场次估计；全中立样本（如世界杯）γ=1
  const gamma = haTotal > 0 && haAwayGoals > 0 ? haHomeGoals / haAwayGoals : 1;
  const base = Math.sqrt(Math.max(mTeam / Math.sqrt(Math.max(gamma, 0.5)), 0.2));
  const attack = new Array(n).fill(base);
  const defense = new Array(n).fill(base);
  for (let i = 0; i < n; i++) {
    if (games[i] > 0) {
      attack[i] = Math.max(0.2, gf[i] / games[i] / mTeam) * base;
      defense[i] = Math.max(0.2, ga[i] / games[i] / mTeam) * base;
    }
  }
  return {
    teamIndex,
    attack,
    defense,
    gamma,
    rho: opts.rhoInit ?? -0.05,
    logLik: NaN,
    iterations: 0,
    converged: true,
  };
}

/**
 * 完整 MLE（退化等级 1）：对 {log α, log β, log γ, ρ} 做带回溯线搜索的
 * 投影梯度上升；规范化约束 mean(log α)=0（规范变换不改变似然）。
 */
export function fitDixonColesMLE(hist: HistMatch[], opts: FitOptions): DcParams {
  const { rows, teamIndex } = indexMatches(hist, opts);
  const n = teamIndex.size;
  const maxIter = opts.maxIter ?? 500;

  // 矩估计初值（log 域）
  const init = momentEstimate(hist, opts);
  const a = init.attack.map((v) => Math.log(v));
  const b = init.defense.map((v) => Math.log(v));
  let g = Math.log(Math.max(init.gamma, 0.5));
  let rho = opts.rhoInit ?? -0.05;
  // 规范化：mean(a)=0（把均值移到 b 上，预测不变）
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) {
    a[i] -= meanA;
    b[i] += meanA;
  }

  const logLik = (av: number[], bv: number[], gv: number, rv: number): number => {
    let ll = 0;
    for (const r of rows) {
      const lambda = Math.exp(av[r.hi] + bv[r.ai] + gv * r.ha);
      const mu = Math.exp(av[r.ai] + bv[r.hi]);
      const t = tau(r.hg, r.ag, lambda, mu, rv);
      if (t <= 0 || !Number.isFinite(t)) return -Infinity;
      ll += r.w * (Math.log(t) - lambda + r.hg * Math.log(lambda) - mu + r.ag * Math.log(mu));
    }
    return ll;
  };

  const grad = (
    av: number[],
    bv: number[],
    gv: number,
    rv: number,
  ): { ga: number[]; gb: number[]; gg: number; gr: number } => {
    const ga = new Array(n).fill(0);
    const gb = new Array(n).fill(0);
    let gg = 0;
    let gr = 0;
    for (const r of rows) {
      const lambda = Math.exp(av[r.hi] + bv[r.ai] + gv * r.ha);
      const mu = Math.exp(av[r.ai] + bv[r.hi]);
      const t = tau(r.hg, r.ag, lambda, mu, rv);
      // ∂ℓ/∂λ、∂ℓ/∂μ、∂ℓ/∂ρ（τ 分支求导）
      let dTdL = 0;
      let dTdM = 0;
      let dTdR = 0;
      if (r.hg === 0 && r.ag === 0) {
        dTdL = -mu * rv;
        dTdM = -lambda * rv;
        dTdR = -lambda * mu;
      } else if (r.hg === 0 && r.ag === 1) {
        dTdL = rv;
        dTdR = lambda;
      } else if (r.hg === 1 && r.ag === 0) {
        dTdM = rv;
        dTdR = mu;
      } else if (r.hg === 1 && r.ag === 1) {
        dTdR = -1;
      }
      const dLdLambda = dTdL / t + r.hg / lambda - 1;
      const dLdMu = dTdM / t + r.ag / mu - 1;
      // λ = exp(a_h + b_a + g)：∂λ/∂a_h = λ，等
      ga[r.hi] += r.w * dLdLambda * lambda;
      gb[r.ai] += r.w * dLdLambda * lambda;
      gg += r.w * dLdLambda * lambda * r.ha;
      ga[r.ai] += r.w * dLdMu * mu;
      gb[r.hi] += r.w * dLdMu * mu;
      gr += (r.w * dTdR) / t;
    }
    return { ga, gb, gg, gr };
  };

  let ll = logLik(a, b, g, rho);
  let lr = 0.2;
  let iterations = 0;
  let converged = false;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const { ga, gb, gg, gr } = grad(a, b, g, rho);
    // 梯度按权重总量归一，避免样本规模影响步长
    const wSum = rows.reduce((s, r) => s + r.w, 0);
    const scale = 1 / Math.max(1, wSum / 50);
    let accepted = false;
    for (let bt = 0; bt < 25; bt++) {
      const step = lr * scale;
      const a2 = a.map((v, i) => v + step * ga[i]);
      const b2 = b.map((v, i) => v + step * gb[i]);
      const g2 = g + step * gg;
      let r2 = opts.freezeRho ? rho : rho + step * gr;
      r2 = Math.min(0.1, Math.max(-0.15, r2));
      // 规范化投影（精确不变）
      const m = a2.reduce((s, v) => s + v, 0) / n;
      for (let i = 0; i < n; i++) {
        a2[i] -= m;
        b2[i] += m;
      }
      const ll2 = logLik(a2, b2, g2, r2);
      if (ll2 > ll) {
        for (let i = 0; i < n; i++) {
          a[i] = a2[i];
          b[i] = b2[i];
        }
        g = g2;
        rho = r2;
        const improved = ll2 - ll;
        ll = ll2;
        lr = Math.min(1, lr * 1.3);
        accepted = true;
        if (improved < 1e-7 * (1 + Math.abs(ll2))) converged = true;
        break;
      }
      lr /= 2;
    }
    if (!accepted || converged) {
      converged = converged || !accepted;
      break;
    }
  }

  return {
    teamIndex,
    attack: a.map((v) => Math.exp(v)),
    defense: b.map((v) => Math.exp(v)),
    gamma: Math.exp(g),
    rho,
    logLik: ll,
    iterations,
    converged,
  };
}

// ---------- 射门质量评分（shots-based ratings） ----------
// Wheatcroft, E. (2020). "A profitable model for predicting the over/under
// market in football." International Journal of Forecasting 36(3):916–932。
// 进球是高噪声实现，射门/射正是更稳定的进攻产出信号。
// 做法：① 全联赛 OLS 标定 伪进球 = c + w1·射门 + w2·射正；
//      ② 响应变量 blended = (1−θ)·真实进球 + θ·伪进球；
//      ③ 用 quasi-Poisson（τ 关闭）重拟合 α/β/γ，ρ 沿用纯进球 DC 的估计。

export interface ShotWeights {
  c: number;
  wShots: number;
  wSot: number;
  samples: number;
}

/** 三参数 OLS（带截距）标定射门→进球映射；样本不足返回 null */
export function fitShotWeights(hist: HistMatch[]): ShotWeights | null {
  const xs: [number, number, number][] = [];
  const ys: number[] = [];
  for (const h of hist) {
    if (h.homeShots !== undefined && h.homeSot !== undefined) {
      xs.push([1, h.homeShots, h.homeSot]);
      ys.push(h.homeGoals);
    }
    if (h.awayShots !== undefined && h.awaySot !== undefined) {
      xs.push([1, h.awayShots, h.awaySot]);
      ys.push(h.awayGoals);
    }
  }
  if (xs.length < 100) return null;
  // 正规方程 (XᵀX)β = Xᵀy，3×3 高斯消元
  const xtx = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const xty = [0, 0, 0];
  for (let k = 0; k < xs.length; k++) {
    for (let i = 0; i < 3; i++) {
      xty[i] += xs[k][i] * ys[k];
      for (let j = 0; j < 3; j++) xtx[i][j] += xs[k][i] * xs[k][j];
    }
  }
  const beta = solve3x3(xtx, xty);
  if (!beta) return null;
  return { c: beta[0], wShots: beta[1], wSot: beta[2], samples: xs.length };
}

function solve3x3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** 射门数据覆盖率（有 shots 列的行占比） */
export function shotsCoverage(hist: HistMatch[]): number {
  if (hist.length === 0) return 0;
  const n = hist.filter(
    (h) => h.homeShots !== undefined && h.homeSot !== undefined && h.awayShots !== undefined && h.awaySot !== undefined,
  ).length;
  return n / hist.length;
}

/** 混合响应变量 getter：该行缺射门数据时退回真实进球 */
export function blendedGoals(theta: number, w: ShotWeights): (h: HistMatch) => { hg: number; ag: number } {
  const pseudo = (shots: number, sot: number) => Math.max(0, w.c + w.wShots * shots + w.wSot * sot);
  return (h) => {
    if (h.homeShots === undefined || h.homeSot === undefined || h.awayShots === undefined || h.awaySot === undefined) {
      return { hg: h.homeGoals, ag: h.awayGoals };
    }
    return {
      hg: (1 - theta) * h.homeGoals + theta * pseudo(h.homeShots, h.homeSot),
      ag: (1 - theta) * h.awayGoals + theta * pseudo(h.awayShots, h.awaySot),
    };
  };
}

/** P(Pois(T) > line)，line 为 x.5 半球线 */
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

/** 拟合质量分级：1=可完整 MLE，2=矩估计，3+ 交由市场 */
export function chooseDcLevel(
  hist: HistMatch[],
  homeTeamId: number,
  awayTeamId: number,
): 1 | 2 | 3 {
  const count = (id: number) =>
    hist.filter((h) => h.homeTeamId === id || h.awayTeamId === id).length;
  const ch = count(homeTeamId);
  const ca = count(awayTeamId);
  if (hist.length >= 100 && ch >= 8 && ca >= 8) return 1;
  if (hist.length >= 20 && ch >= 4 && ca >= 4) return 2;
  return 3;
}
