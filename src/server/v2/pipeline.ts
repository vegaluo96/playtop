import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  matchSnapshots,
  matches,
  modelRuns,
  oddsSnapshots,
  reportLocks,
  reportVersions,
  settlements,
  trackRecords,
  predictions,
} from "../db/schema";
import type { EngineBundle, EngineOutput } from "../engine/types";
import { shinDevig, twoWayDevig } from "../engine/devig";
import { settle1x2, settleOu } from "../engine/markets";
import { hashObject } from "../lib/hash";
import { now } from "../lib/time";
import { latestOddsBookRows, latestSnapshots } from "../services/snapshots";
import { listSourceHealth } from "../services/sourceHealth";
import { leagueById } from "../services/teamResolver";
import { appendAuditHash } from "./audit";

/**
 * V2 流水线（REBUILD_PLAN 阶段 1-2 的领域对象显性化）：
 * 由 V1 流水线的三个单点钩子驱动（analyze / lock / settle），零双倍计算：
 *   analyzeMatch 成功 → captureMatchSnapshot + captureOddsFlat + recordModelRun + recordReportVersion
 *   开赛锁定        → recordReportLock
 *   赛后结算        → recordSettlements + refreshTrackRecords
 * 所有关键对象 append 进 audit_hashes 通用链。钩子全部 try/catch——V2 失败绝不阻塞 V1。
 */

export type SnapshotType = "T72" | "T24" | "T6" | "T1" | "lineup" | "lock" | "post";

/** 距开球时间 → 快照档位 */
export function snapshotTypeForKickoff(kickoffAt: number, at: number): SnapshotType {
  const h = (kickoffAt - at) / 3_600_000;
  if (h <= 0) return "lock";
  if (h <= 1) return "T1";
  if (h <= 6) return "T6";
  if (h <= 24) return "T24";
  return "T72";
}

/** 归并 data_snapshots（V1 细粒度）为一份完整研究底稿（V2 match_snapshots），链式哈希 */
export function captureMatchSnapshot(matchId: number, type: SnapshotType): number {
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new Error("比赛不存在");
  const snaps = latestSnapshots(matchId);
  const payload = (k: string) => {
    const row = snaps.get(k as never);
    return row ? row.payload : null;
  };
  const statsJson = JSON.stringify({
    h2h: payload("h2h") ? JSON.parse(payload("h2h")!) : null,
    form: payload("form") ? JSON.parse(payload("form")!) : null,
    team_stats: payload("team_stats") ? JSON.parse(payload("team_stats")!) : null,
    external_ratings: payload("external_ratings") ? JSON.parse(payload("external_ratings")!) : null,
    player_stats: payload("player_stats") ? JSON.parse(payload("player_stats")!) : null,
  });
  const prev = db
    .select({ snapshotHash: matchSnapshots.snapshotHash })
    .from(matchSnapshots)
    .where(eq(matchSnapshots.matchId, matchId))
    .orderBy(desc(matchSnapshots.id))
    .limit(1)
    .get();
  const body = {
    matchId,
    snapshotType: type,
    capturedAt: now(),
    kickoffAt: match.kickoffAt,
    teamStateJson: payload("team_stats"),
    lineupJson: payload("lineups"),
    injuryJson: JSON.stringify({
      injuries: payload("injuries") ? JSON.parse(payload("injuries")!) : null,
      suspensions: payload("suspensions") ? JSON.parse(payload("suspensions")!) : null,
    }),
    weatherJson: payload("weather"),
    standingsJson: payload("standings"),
    statsJson,
    providerHealthJson: JSON.stringify(
      listSourceHealth().map((h) => ({ source: h.source, consecutiveFails: h.consecutiveFails, lastOkAt: h.lastOkAt })),
    ),
  };
  const snapshotHash = hashObject({ ...body, prev: prev?.snapshotHash ?? null });
  const inserted = db
    .insert(matchSnapshots)
    .values({ ...body, snapshotHash, previousSnapshotHash: prev?.snapshotHash ?? null, createdAt: now() })
    .returning({ id: matchSnapshots.id })
    .get();
  return inserted.id;
}

/** 盘口扁平化：每家 × 每玩法 × 每方向一行（标准化概率：1X2 Shin / 两向 power） */
export function captureOddsFlat(matchId: number): number {
  const books = latestOddsBookRows(matchId);
  let inserted = 0;
  const at = now();
  for (const { bookmaker, row } of books) {
    const p = JSON.parse(row.payload) as {
      oneXTwo?: { home: number; draw: number; away: number };
      ou: { line: number; over: number; under: number }[];
      ah: { line: number; home: number; away: number }[];
      correctScores?: { score: string; odds: number }[];
    };
    const push = (marketType: "one_x_two" | "asian_handicap" | "over_under" | "correct_score", line: number | null, selection: string, odds: number, normalized: number | null) => {
      db.insert(oddsSnapshots)
        .values({
          matchId,
          providerId: null,
          bookmakerName: bookmaker,
          marketType,
          line,
          selection,
          oddsDecimal: odds,
          impliedProbability: 1 / odds,
          normalizedProbability: normalized,
          capturedAt: at,
          oddsHash: hashObject({ matchId, bookmaker, marketType, line, selection, odds }),
          createdAt: at,
        })
        .run();
      inserted++;
    };
    if (p.oneXTwo) {
      const shin = shinDevig(p.oneXTwo);
      push("one_x_two", null, "home", p.oneXTwo.home, shin.probs.home);
      push("one_x_two", null, "draw", p.oneXTwo.draw, shin.probs.draw);
      push("one_x_two", null, "away", p.oneXTwo.away, shin.probs.away);
    }
    for (const ou of p.ou ?? []) {
      const pOver = twoWayDevig(ou.over, ou.under);
      push("over_under", ou.line, "over", ou.over, pOver);
      push("over_under", ou.line, "under", ou.under, 1 - pOver);
    }
    for (const ah of p.ah ?? []) {
      const pHome = twoWayDevig(ah.home, ah.away);
      push("asian_handicap", ah.line, "home", ah.home, pHome);
      push("asian_handicap", ah.line, "away", ah.away, 1 - pHome);
    }
    for (const cs of p.correctScores ?? []) {
      push("correct_score", null, cs.score, cs.odds, null);
    }
  }
  return inserted;
}

export interface RecordRunInput {
  matchId: number;
  bundle: EngineBundle;
  engine: EngineOutput;
  versionType: SnapshotType;
  title: string;
  freePreview: string;
  paidContent: string;
  summary: unknown;
  whitelistSource: string[];
}

/** analyze 钩子：快照归并 + 盘口扁平化 + ModelRun + ReportVersion 一次落齐 */
export function recordV2Artifacts(input: RecordRunInput): { modelRunId: number; reportVersionId: number; snapshotId: number } {
  const snapshotId = captureMatchSnapshot(input.matchId, input.versionType);
  captureOddsFlat(input.matchId);
  const inputJson = JSON.stringify(input.bundle);
  const outputJson = JSON.stringify(input.engine);
  const run = db
    .insert(modelRuns)
    .values({
      matchId: input.matchId,
      snapshotId,
      modelVersion: input.engine.modelVersion,
      inputJson,
      inputHash: hashObject({ ...input.bundle, computedAt: 0 }),
      outputJson,
      outputHash: hashObject({ ...input.engine, computedAt: 0, trace: [] }),
      status: "success",
      createdAt: now(),
    })
    .returning({ id: modelRuns.id })
    .get();
  appendAuditHash("model_run", run.id, { inputHash: hashObject({ ...input.bundle, computedAt: 0 }) });

  const prev = db
    .select({ reportHash: reportVersions.reportHash })
    .from(reportVersions)
    .where(eq(reportVersions.matchId, input.matchId))
    .orderBy(desc(reportVersions.id))
    .limit(1)
    .get();
  const body = {
    matchId: input.matchId,
    snapshotId,
    modelRunId: run.id,
    versionType: input.versionType,
    title: input.title,
    freePreview: input.freePreview,
    paidContent: input.paidContent,
    summaryJson: JSON.stringify(input.summary),
    numbersWhitelistJson: JSON.stringify(input.whitelistSource),
  };
  const reportHash = hashObject({ ...body, prev: prev?.reportHash ?? null });
  const rv = db
    .insert(reportVersions)
    .values({ ...body, reportHash, previousReportHash: prev?.reportHash ?? null, isPublic: 0, createdAt: now() })
    .returning({ id: reportVersions.id })
    .get();
  appendAuditHash("report_version", rv.id, { reportHash });
  return { modelRunId: run.id, reportVersionId: rv.id, snapshotId };
}

/** 开赛锁定钩子：终版三元组 + 锁定哈希 */
export function recordReportLock(matchId: number): number | null {
  if (db.select().from(reportLocks).where(eq(reportLocks.matchId, matchId)).get()) return null; // 幂等
  const snapshotId = captureMatchSnapshot(matchId, "lock");
  const run = db.select().from(modelRuns).where(eq(modelRuns.matchId, matchId)).orderBy(desc(modelRuns.id)).limit(1).get();
  const rv = db.select().from(reportVersions).where(eq(reportVersions.matchId, matchId)).orderBy(desc(reportVersions.id)).limit(1).get();
  const lockedAt = now();
  const lockHash = hashObject({ matchId, snapshotId, runId: run?.id ?? null, rvId: rv?.id ?? null, lockedAt });
  const lock = db
    .insert(reportLocks)
    .values({
      matchId,
      finalSnapshotId: snapshotId,
      finalModelRunId: run?.id ?? null,
      finalReportVersionId: rv?.id ?? null,
      lockedAt,
      lockHash,
      createdAt: lockedAt,
    })
    .returning({ id: reportLocks.id })
    .get();
  appendAuditHash("report_lock", lock.id, { lockHash });
  return lock.id;
}

/** 亚盘四态结算（含 quarter 线半赢半输；V1 的 settleAh 折算为两态，V2 保留细粒度） */
export function settleAhDetailed(margin: number, line: number, side: "home" | "away"): "win" | "lose" | "push" | "half_win" | "half_lose" {
  const adj = side === "home" ? margin + line : -(margin + line);
  if (Math.abs(adj) < 1e-9) return "push";
  if (Math.abs(adj - 0.25) < 1e-9) return "half_win";
  if (Math.abs(adj + 0.25) < 1e-9) return "half_lose";
  return adj > 0 ? "win" : "lose";
}

const ROI: Record<string, (odds: number) => number> = {
  win: (o) => o - 1,
  half_win: (o) => (o - 1) / 2,
  push: () => 0,
  void: () => 0,
  half_lose: () => -0.5,
  lose: () => -1,
};

/** 结算钩子：逐观点结算（ROI/CLV/Brier）+ is_public 翻转 */
export function recordSettlements(matchId: number, outcome: { homeGoals: number; awayGoals: number }): number {
  const lock = db.select().from(reportLocks).where(eq(reportLocks.matchId, matchId)).get();
  const run = lock?.finalModelRunId
    ? db.select().from(modelRuns).where(eq(modelRuns.id, lock.finalModelRunId)).get()
    : db.select().from(modelRuns).where(eq(modelRuns.matchId, matchId)).orderBy(desc(modelRuns.id)).limit(1).get();
  if (!run) return 0;
  if (db.select().from(settlements).where(eq(settlements.matchId, matchId)).get()) return 0; // 幂等
  const engine = JSON.parse(run.outputJson) as EngineOutput;
  const margin = outcome.homeGoals - outcome.awayGoals;
  const total = outcome.homeGoals + outcome.awayGoals;
  // Brier：终版集成三向概率 vs 实际赛果
  const o = { home: margin > 0 ? 1 : 0, draw: margin === 0 ? 1 : 0, away: margin < 0 ? 1 : 0 };
  const p = engine.ensemble.probs;
  const brier = (p.home - o.home) ** 2 + (p.draw - o.draw) ** 2 + (p.away - o.away) ** 2;
  // CLV 口径：V1 predictions 已存锁定时收盘价
  const preds = db.select().from(predictions).where(eq(predictions.matchId, matchId)).all();
  let count = 0;
  for (const pick of engine.picks) {
    // 与 V1 账本同口径：锁定时未落 predictions 的观点（边界失效/未发布）按观望处理，不进结算
    const pred = preds.find((x) => x.market === pick.market && x.selection === pick.selection && x.line === pick.line);
    if (!pred) continue;
    let result: "win" | "lose" | "push" | "void" | "half_win" | "half_lose";
    if (pick.market === "1x2") {
      const r = settle1x2(outcome.homeGoals, outcome.awayGoals, pick.selection);
      result = r === "hit" ? "win" : r === "push" ? "push" : "lose";
    } else if (pick.market === "ou") {
      const r = settleOu(total, pick.line ?? 2.5, pick.selection as "over" | "under");
      result = r === "hit" ? "win" : r === "push" ? "push" : "lose";
    } else {
      result = settleAhDetailed(margin, pick.line ?? 0, pick.selection as "home" | "away");
    }
    const roi = pick.odds !== null ? ROI[result](pick.odds) : null;
    const clv = pick.odds !== null && pred.closingOdds ? pick.odds / pred.closingOdds - 1 : null;
    const body = {
      matchId,
      reportLockId: lock?.id ?? null,
      finalResultJson: JSON.stringify(outcome),
      opinionJson: JSON.stringify(pick),
      settlementResult: result,
      roi,
      clv,
      brierScore: brier,
      settledAt: now(),
    };
    const row = db
      .insert(settlements)
      .values({ ...body, settlementHash: hashObject(body), createdAt: now() })
      .returning({ id: settlements.id })
      .get();
    appendAuditHash("settlement", row.id, { matchId, result, roi });
    count++;
  }
  // 全部研报版本赛后公开
  db.update(reportVersions).set({ isPublic: 1 }).where(eq(reportVersions.matchId, matchId)).run();
  return count;
}

/** 战绩物化：按 scope 全量重算（结算后调用；数据量在万级前全量重算最简单且正确） */
export function refreshTrackRecords(matchId: number): void {
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  const leagueCode = match ? (leagueById(match.leagueId)?.code ?? "unknown") : "unknown";
  const scopes: { scopeType: "global" | "league" | "market"; scopeKey: string; filter: (s: typeof settlements.$inferSelect) => boolean }[] = [
    { scopeType: "global", scopeKey: "all", filter: () => true },
    {
      scopeType: "league",
      scopeKey: leagueCode,
      filter: (s) => {
        const m = db.select().from(matches).where(eq(matches.id, s.matchId)).get();
        return m ? (leagueById(m.leagueId)?.code ?? "unknown") === leagueCode : false;
      },
    },
    ...(["1x2", "ou", "ah"] as const).map((mk) => ({
      scopeType: "market" as const,
      scopeKey: mk,
      filter: (s: typeof settlements.$inferSelect) => (JSON.parse(s.opinionJson) as { market: string }).market === mk,
    })),
  ];
  const all = db.select().from(settlements).orderBy(settlements.id).all();
  // 观望场次：已锁定结算但无任何观点（不进胜负分母，单独计数）
  const settledMatchIds = new Set(
    db.select({ id: matches.id }).from(matches).where(eq(matches.status, "settled")).all().map((r) => r.id),
  );
  const matchesWithOpinions = new Set(all.map((r) => r.matchId));
  const watchOnly = [...settledMatchIds].filter((id) => !matchesWithOpinions.has(id));
  for (const scope of scopes) {
    const rows = all.filter(scope.filter);
    const watchOnlyCount =
      scope.scopeType === "global"
        ? watchOnly.length
        : scope.scopeType === "league"
          ? watchOnly.filter((id) => {
              const m = db.select().from(matches).where(eq(matches.id, id)).get();
              return m ? (leagueById(m.leagueId)?.code ?? "unknown") === scope.scopeKey : false;
            }).length
          : 0;
    if (rows.length === 0 && watchOnlyCount === 0) continue;
    const wins = rows.filter((r) => r.settlementResult === "win" || r.settlementResult === "half_win").length;
    const losses = rows.filter((r) => r.settlementResult === "lose" || r.settlementResult === "half_lose").length;
    const pushes = rows.filter((r) => r.settlementResult === "push" || r.settlementResult === "void").length;
    const rois = rows.map((r) => r.roi).filter((x): x is number => x !== null);
    const clvs = rows.map((r) => r.clv).filter((x): x is number => x !== null);
    const briers = rows.map((r) => r.brierScore).filter((x): x is number => x !== null);
    // 最大回撤：按结算顺序累积 ROI 的峰谷差
    let peak = 0;
    let equity = 0;
    let maxDd = 0;
    for (const r of rows) {
      equity += r.roi ?? 0;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak - equity);
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const values = {
      totalMatches: new Set(rows.map((r) => r.matchId)).size + watchOnlyCount,
      publishedOpinions: rows.length,
      watchOnlyCount,
      wins,
      losses,
      pushes,
      roi: avg(rois),
      clv: avg(clvs),
      maxDrawdown: maxDd,
      brierScore: avg(briers),
      updatedAt: now(),
    };
    const existing = db
      .select()
      .from(trackRecords)
      .where(eq(trackRecords.scopeType, scope.scopeType))
      .all()
      .find((r) => r.scopeKey === scope.scopeKey);
    if (existing) {
      db.update(trackRecords).set(values).where(eq(trackRecords.id, existing.id)).run();
    } else {
      db.insert(trackRecords).values({ scopeType: scope.scopeType, scopeKey: scope.scopeKey, ...values }).run();
    }
  }
}
