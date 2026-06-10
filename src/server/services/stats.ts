import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db";
import { analyses, matches, outcomes, predictions, teams } from "../db/schema";
import { decomposeAhLine } from "../engine/markets";
import { engineOutputSchema } from "../engine/types";
import { now } from "../lib/time";

/**
 * 战绩与校准统计：全部从已结算的不可变记录实时计算，无任何人工修饰空间。
 * 职业口径：命中率 + Wilson 区间 + 平注 ROI + CLV + 概率校准（RPS / 对数损失）对比市场基线。
 */

export interface MarketRecord {
  market: string;
  n: number;
  hits: number;
  misses: number;
  pushes: number;
  hitRate: number | null;
  wilsonLow: number | null;
  wilsonHigh: number | null;
  /** 平注 ROI（每注 1 单位，按真实盘口与亚盘拆腿规则计算盈亏） */
  roi: number | null;
  roiN: number;
  /** 平均 CLV：锁定赔率相对收盘赔率的偏差，正值=持续拿到比收盘更好的价格 */
  avgClv: number | null;
}

function wilson(p: number, n: number): { low: number; high: number } {
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (center - spread) / denom), high: Math.min(1, (center + spread) / denom) };
}

/** 单注盈亏（1 单位本金；亚盘按拆腿，整数/四分盘走水规则与结算一致） */
export function predictionPnl(
  p: { market: string; selection: string; line: number | null; oddsAtPublish: number | null; result: string },
  outcome: { homeGoals: number; awayGoals: number },
): number | null {
  if (p.oddsAtPublish === null) return null;
  const o = p.oddsAtPublish;
  if (p.market === "1x2") return p.result === "hit" ? o - 1 : -1;
  if (p.market === "ou") {
    if (p.result === "push") return 0;
    return p.result === "hit" ? o - 1 : -1;
  }
  // ah：精确按腿计算
  const margin = outcome.homeGoals - outcome.awayGoals;
  const legs = decomposeAhLine(p.line ?? 0);
  let pnl = 0;
  for (const leg of legs) {
    const adj = margin + leg;
    const homeLeg = adj > 1e-9 ? 1 : adj < -1e-9 ? -1 : 0;
    const myLeg = p.selection === "home" ? homeLeg : -homeLeg;
    pnl += myLeg > 0 ? (o - 1) / legs.length : myLeg < 0 ? -1 / legs.length : 0;
  }
  return pnl;
}

export function recordOverview(periodDays: number | null): MarketRecord[] {
  const conds = [isNotNull(predictions.settledAt), inArray(predictions.result, ["hit", "miss", "push"])];
  if (periodDays !== null) conds.push(gte(predictions.settledAt, now() - periodDays * 86_400_000));
  const rows = db
    .select({ p: predictions, o: outcomes })
    .from(predictions)
    .innerJoin(outcomes, eq(outcomes.matchId, predictions.matchId))
    .where(and(...conds))
    .all();
  const out: MarketRecord[] = [];
  for (const market of ["1x2", "ou", "ah"] as const) {
    const ms = rows.filter((r) => r.p.market === market);
    const hits = ms.filter((r) => r.p.result === "hit").length;
    const misses = ms.filter((r) => r.p.result === "miss").length;
    const pushes = ms.filter((r) => r.p.result === "push").length;
    const decisive = hits + misses;
    let roiSum = 0;
    let roiN = 0;
    let clvSum = 0;
    let clvN = 0;
    for (const r of ms) {
      const pnl = predictionPnl(r.p, r.o);
      if (pnl !== null) {
        roiSum += pnl;
        roiN++;
      }
      if (r.p.oddsAtPublish && r.p.closingOdds && r.p.closingOdds > 1) {
        clvSum += r.p.oddsAtPublish / r.p.closingOdds - 1;
        clvN++;
      }
    }
    const hitRate = decisive > 0 ? hits / decisive : null;
    const ci = hitRate !== null && decisive > 0 ? wilson(hitRate, decisive) : null;
    out.push({
      market,
      n: ms.length,
      hits,
      misses,
      pushes,
      hitRate,
      wilsonLow: ci?.low ?? null,
      wilsonHigh: ci?.high ?? null,
      roi: roiN > 0 ? roiSum / roiN : null,
      roiN,
      avgClv: clvN > 0 ? clvSum / clvN : null,
    });
  }
  return out;
}

export interface RecordRow {
  matchId: number;
  kickoffAt: number;
  league: string;
  homeName: string;
  awayName: string;
  market: string;
  selection: string;
  line: number | null;
  modelProb: number;
  oddsAtPublish: number | null;
  result: string;
  homeGoals: number;
  awayGoals: number;
  pnl: number | null;
}

export function recordList(limit = 100): RecordRow[] {
  const home = alias(teams, "home");
  const away = alias(teams, "away");
  const rows = db
    .select({
      p: predictions,
      m: matches,
      o: outcomes,
      homeName: home.name,
      awayName: away.name,
    })
    .from(predictions)
    .innerJoin(matches, eq(matches.id, predictions.matchId))
    .innerJoin(outcomes, eq(outcomes.matchId, predictions.matchId))
    .innerJoin(home, eq(home.id, matches.homeTeamId))
    .innerJoin(away, eq(away.id, matches.awayTeamId))
    .where(and(isNotNull(predictions.settledAt), inArray(predictions.result, ["hit", "miss", "push"])))
    .orderBy(desc(matches.kickoffAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    matchId: r.m.id,
    kickoffAt: r.m.kickoffAt,
    league: "",
    homeName: r.homeName,
    awayName: r.awayName,
    market: r.p.market,
    selection: r.p.selection,
    line: r.p.line,
    modelProb: r.p.modelProb,
    oddsAtPublish: r.p.oddsAtPublish,
    result: r.p.result,
    homeGoals: r.o.homeGoals,
    awayGoals: r.o.awayGoals,
    pnl: predictionPnl(r.p, r.o),
  }));
}

export interface CalibrationStats {
  n: number;
  model: { rps: number; logLoss: number } | null;
  market: { rps: number; logLoss: number } | null;
}

/** RPS（Constantinou & Fenton 2012 推荐的足球三向评分）+ 对数损失，模型 vs 市场基线 */
export function calibrationStats(): CalibrationStats {
  const rows = db
    .select({ a: analyses, o: outcomes })
    .from(matches)
    .innerJoin(analyses, eq(analyses.id, matches.finalAnalysisId))
    .innerJoin(outcomes, eq(outcomes.matchId, matches.id))
    .where(and(eq(matches.status, "settled"), eq(outcomes.finalStatus, "finished")))
    .all();
  let n = 0;
  let mRps = 0;
  let mLog = 0;
  let kRps = 0;
  let kLog = 0;
  let kN = 0;
  for (const { a, o } of rows) {
    const engine = engineOutputSchema.parse(JSON.parse(a.engineOutput));
    const idx = o.homeGoals > o.awayGoals ? 0 : o.homeGoals === o.awayGoals ? 1 : 2;
    const obs = [idx === 0 ? 1 : 0, idx === 1 ? 1 : 0, idx === 2 ? 1 : 0];
    const rps = (p: number[]) => {
      let s = 0;
      let cp = 0;
      let co = 0;
      for (let k = 0; k < 2; k++) {
        cp += p[k];
        co += obs[k];
        s += (cp - co) ** 2;
      }
      return s / 2;
    };
    const logloss = (p: number[]) => -Math.log(Math.max(1e-9, p[idx]));
    const ep = [engine.ensemble.probs.home, engine.ensemble.probs.draw, engine.ensemble.probs.away];
    mRps += rps(ep);
    mLog += logloss(ep);
    n++;
    if (engine.market) {
      const kp = [engine.market.devigged.home, engine.market.devigged.draw, engine.market.devigged.away];
      kRps += rps(kp);
      kLog += logloss(kp);
      kN++;
    }
  }
  return {
    n,
    model: n > 0 ? { rps: mRps / n, logLoss: mLog / n } : null,
    market: kN > 0 ? { rps: kRps / kN, logLoss: kLog / kN } : null,
  };
}
