import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { analyses, historyMatches, matches, outcomes, predictions } from "../db/schema";
import { engineOutputSchema, type NormalizedOdds } from "../engine/types";
import { settle1x2, settleAh, settleOu } from "../engine/markets";
import { HttpError } from "../lib/api";
import { now } from "../lib/time";
import { logAudit } from "./audit";
import { applyMatchToElo } from "./eloService";
import { getMatch, matchesAtKickoff, matchesByStatus, transitionMatch } from "./matchesService";
import { voidMatch } from "./publish";
import { latestSnapshots, snapshotPayload } from "./snapshots";
import { leagueById } from "./teamResolver";

/**
 * 开赛锁定 + 赛果 + 结算：
 * - 开球时刻：把最新已发布版本锁定为"终版"，按当时盘口落 predictions（战绩口径），状态 → in_play
 * - 赛果：CSV 自动回填 / 管理员录入（即时生效）/ AI 检索（provisional，须管理员确认）
 * - 结算：判定命中 → 报告全量转 public（免费公开）→ Elo 与历史库回填 → settled
 */

export function lockFinalAnalysisAtKickoff(): number {
  let locked = 0;
  for (const match of matchesAtKickoff()) {
    const final = db
      .select()
      .from(analyses)
      .where(and(eq(analyses.matchId, match.id), eq(analyses.status, "published")))
      .orderBy(desc(analyses.version))
      .limit(1)
      .get();
    if (!final) {
      // 没有任何已发布版本（异常情况）：直接进入 in_play，不产生战绩
      transitionMatch(match.id, "in_play");
      continue;
    }
    const engine = engineOutputSchema.parse(JSON.parse(final.engineOutput));
    const closing = snapshotPayload<NormalizedOdds>(latestSnapshots(match.id).get("odds"));
    db.transaction((tx) => {
      tx.update(matches)
        .set({ finalAnalysisId: final.id, updatedAt: now() })
        .where(eq(matches.id, match.id))
        .run();
      for (const pick of engine.picks) {
        let closingOdds: number | null = null;
        if (closing) {
          if (pick.market === "1x2" && closing.oneXTwo) {
            closingOdds = closing.oneXTwo[pick.selection as "home" | "draw" | "away"] ?? null;
          } else if (pick.market === "ou") {
            const line = closing.ou.find((o) => o.line === pick.line);
            closingOdds = line ? line[pick.selection as "over" | "under"] : null;
          } else if (pick.market === "ah") {
            const line = closing.ah.find((o) => o.line === pick.line);
            closingOdds = line ? line[pick.selection as "home" | "away"] : null;
          }
        }
        tx.insert(predictions)
          .values({
            analysisId: final.id,
            matchId: match.id,
            market: pick.market,
            selection: pick.selection,
            line: pick.line,
            modelProb: pick.modelProb,
            oddsAtPublish: pick.odds,
            closingOdds,
            ev: pick.ev,
            kelly: pick.kelly,
            result: "pending",
          })
          .run();
      }
    });
    transitionMatch(match.id, "in_play");
    locked++;
  }
  return locked;
}

export function recordOutcome(input: {
  matchId: number;
  homeGoals: number;
  awayGoals: number;
  htHome?: number | null;
  htAway?: number | null;
  finalStatus?: "finished" | "abandoned" | "postponed";
  source: "csv" | "llm" | "manual";
  provisional?: boolean;
  recordedBy?: number;
}): void {
  const match = getMatch(input.matchId);
  if (["scheduled", "collecting", "ready", "analyzed"].includes(match.status)) {
    throw new HttpError(400, "比赛尚未发布/开赛，不能录入赛果");
  }
  if (match.status === "settled" || match.status === "void") {
    throw new HttpError(400, "比赛已终结，不能再录入赛果");
  }
  const finalStatus = input.finalStatus ?? "finished";
  const provisional = input.provisional ? 1 : 0;
  const existing = db.select().from(outcomes).where(eq(outcomes.matchId, input.matchId)).get();
  // 已有确认赛果时，provisional 来源不得覆盖
  if (existing && existing.provisional === 0 && provisional === 1) return;
  if (existing) {
    db.update(outcomes)
      .set({
        homeGoals: input.homeGoals,
        awayGoals: input.awayGoals,
        htHome: input.htHome ?? null,
        htAway: input.htAway ?? null,
        finalStatus,
        source: input.source,
        provisional,
        recordedBy: input.recordedBy ?? null,
        recordedAt: now(),
      })
      .where(eq(outcomes.matchId, input.matchId))
      .run();
  } else {
    db.insert(outcomes)
      .values({
        matchId: input.matchId,
        homeGoals: input.homeGoals,
        awayGoals: input.awayGoals,
        htHome: input.htHome ?? null,
        htAway: input.htAway ?? null,
        finalStatus,
        source: input.source,
        provisional,
        recordedBy: input.recordedBy ?? null,
        recordedAt: now(),
      })
      .run();
  }
  if (input.recordedBy) {
    logAudit({
      actorId: input.recordedBy,
      action: "record_outcome",
      entity: "match",
      entityId: input.matchId,
      detail: { ...input },
    });
  }
  if (finalStatus !== "finished") {
    voidMatch(input.matchId, finalStatus === "abandoned" ? "比赛腰斩" : "比赛延期", input.recordedBy);
    return;
  }
  if (match.status === "in_play" && provisional === 0) {
    transitionMatch(input.matchId, "finished");
  }
}

/** 管理员确认 AI 检索的临时赛果 */
export function confirmOutcome(matchId: number, adminId: number): void {
  const row = db.select().from(outcomes).where(eq(outcomes.matchId, matchId)).get();
  if (!row) throw new HttpError(404, "暂无待确认赛果");
  db.update(outcomes).set({ provisional: 0, recordedBy: adminId, recordedAt: now() }).where(eq(outcomes.matchId, matchId)).run();
  const match = getMatch(matchId);
  if (match.status === "in_play") transitionMatch(matchId, "finished");
  logAudit({ actorId: adminId, action: "confirm_outcome", entity: "match", entityId: matchId });
}

/** 结算所有 finished 且赛果已确认的比赛 */
export function settleDueMatches(): number {
  let settled = 0;
  for (const match of matchesByStatus(["finished"])) {
    const outcome = db
      .select()
      .from(outcomes)
      .where(and(eq(outcomes.matchId, match.id), eq(outcomes.provisional, 0)))
      .get();
    if (!outcome || outcome.finalStatus !== "finished") continue;
    const margin = outcome.homeGoals - outcome.awayGoals;
    const total = outcome.homeGoals + outcome.awayGoals;
    db.transaction((tx) => {
      const preds = tx.select().from(predictions).where(eq(predictions.matchId, match.id)).all();
      for (const p of preds) {
        if (p.result !== "pending") continue;
        let result: "hit" | "miss" | "push";
        if (p.market === "1x2") result = settle1x2(outcome.homeGoals, outcome.awayGoals, p.selection);
        else if (p.market === "ou") result = settleOu(total, p.line ?? 2.5, p.selection as "over" | "under");
        else result = settleAh(margin, p.line ?? 0, p.selection as "home" | "away");
        tx.update(predictions).set({ result, settledAt: now() }).where(eq(predictions.id, p.id)).run();
      }
      // 全部已发布版本转 public（赛后免费公开，含完整改版历史）
      tx.update(analyses)
        .set({ status: "public", publicAt: now(), updatedAt: now() })
        .where(and(eq(analyses.matchId, match.id), eq(analyses.status, "published"), isNotNull(analyses.publishedAt)))
        .run();
    });
    // Elo 增量更新 + 历史库回填（喂后续比赛的模型）
    applyMatchToElo({
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeGoals: outcome.homeGoals,
      awayGoals: outcome.awayGoals,
      neutral: match.neutral === 1,
    });
    const league = leagueById(match.leagueId);
    try {
      db.insert(historyMatches)
        .values({
          leagueId: match.leagueId,
          season: league?.code === "INT" ? String(new Date(match.kickoffAt).getUTCFullYear()) : null,
          playedAt: match.kickoffAt,
          homeTeamId: match.homeTeamId,
          awayTeamId: match.awayTeamId,
          homeGoals: outcome.homeGoals,
          awayGoals: outcome.awayGoals,
          htHome: outcome.htHome,
          htAway: outcome.htAway,
          neutral: match.neutral,
          dedupKey: `match|${match.id}`,
          createdAt: now(),
        })
        .run();
    } catch (e) {
      if (!(e instanceof Error && /UNIQUE/.test(e.message))) throw e;
    }
    transitionMatch(match.id, "settled");
    settled++;
  }
  return settled;
}
