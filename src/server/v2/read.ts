import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db";
import {
  leagues,
  matchSnapshots,
  matches,
  modelRuns,
  oddsSnapshots,
  outcomes,
  reportLocks,
  reportVersions,
  settlements,
  teams,
  trackRecords,
} from "../db/schema";
import { verifyAuditChain } from "./audit";

/** V1 状态机 → V2 比赛状态语义 */
export function v2MatchStatus(v1: string): "scheduled" | "live" | "finished" | "postponed" | "cancelled" {
  if (v1 === "in_play") return "live";
  if (v1 === "finished" || v1 === "settled") return "finished";
  if (v1 === "void") return "cancelled";
  return "scheduled";
}

const home = alias(teams, "v2_home");
const away = alias(teams, "v2_away");

export function v2ListMatches(limit = 100) {
  const rows = db
    .select({ m: matches, league: leagues.name, leagueCode: leagues.code, homeName: home.name, awayName: away.name })
    .from(matches)
    .innerJoin(leagues, eq(leagues.id, matches.leagueId))
    .innerJoin(home, eq(home.id, matches.homeTeamId))
    .innerJoin(away, eq(away.id, matches.awayTeamId))
    .orderBy(desc(matches.kickoffAt))
    .limit(limit)
    .all();
  return rows.map(({ m, league, leagueCode, homeName, awayName }) => {
    const latestReport = db
      .select({ id: reportVersions.id, versionType: reportVersions.versionType, createdAt: reportVersions.createdAt, isPublic: reportVersions.isPublic })
      .from(reportVersions)
      .where(eq(reportVersions.matchId, m.id))
      .orderBy(desc(reportVersions.id))
      .limit(1)
      .get();
    const lock = db.select({ id: reportLocks.id, lockedAt: reportLocks.lockedAt }).from(reportLocks).where(eq(reportLocks.matchId, m.id)).get();
    const settled = db.select({ id: settlements.id }).from(settlements).where(eq(settlements.matchId, m.id)).limit(1).get();
    const outcome = db.select().from(outcomes).where(eq(outcomes.matchId, m.id)).get();
    return {
      id: m.id,
      league,
      leagueCode,
      season: null as string | null,
      home: homeName,
      away: awayName,
      kickoffAt: m.kickoffAt,
      status: v2MatchStatus(m.status),
      homeScore: outcome?.homeGoals ?? null,
      awayScore: outcome?.awayGoals ?? null,
      pricePoints: m.pricePoints,
      latestReport: latestReport ?? null,
      locked: !!lock,
      lockedAt: lock?.lockedAt ?? null,
      settled: !!settled,
    };
  });
}

export function v2ReportVersion(id: number) {
  return db.select().from(reportVersions).where(eq(reportVersions.id, id)).get() ?? null;
}

export function v2LatestReportForMatch(matchId: number) {
  return (
    db.select().from(reportVersions).where(eq(reportVersions.matchId, matchId)).orderBy(desc(reportVersions.id)).limit(1).get() ?? null
  );
}

export function v2TrackRecords() {
  return db.select().from(trackRecords).all();
}

/** 公开审计链：某场比赛的完整对象链（哈希与元数据，不泄漏付费正文） */
export function v2AuditChain(matchId: number) {
  const match = v2ListMatches(10000).find((m) => m.id === matchId) ?? null;
  if (!match) return null;
  const snapshots = db
    .select({
      id: matchSnapshots.id,
      snapshotType: matchSnapshots.snapshotType,
      capturedAt: matchSnapshots.capturedAt,
      snapshotHash: matchSnapshots.snapshotHash,
      previousSnapshotHash: matchSnapshots.previousSnapshotHash,
    })
    .from(matchSnapshots)
    .where(eq(matchSnapshots.matchId, matchId))
    .orderBy(matchSnapshots.id)
    .all();
  const runs = db
    .select({
      id: modelRuns.id,
      modelVersion: modelRuns.modelVersion,
      inputHash: modelRuns.inputHash,
      outputHash: modelRuns.outputHash,
      status: modelRuns.status,
      createdAt: modelRuns.createdAt,
    })
    .from(modelRuns)
    .where(eq(modelRuns.matchId, matchId))
    .orderBy(modelRuns.id)
    .all();
  const versions = db
    .select({
      id: reportVersions.id,
      versionType: reportVersions.versionType,
      title: reportVersions.title,
      reportHash: reportVersions.reportHash,
      previousReportHash: reportVersions.previousReportHash,
      isPublic: reportVersions.isPublic,
      createdAt: reportVersions.createdAt,
    })
    .from(reportVersions)
    .where(eq(reportVersions.matchId, matchId))
    .orderBy(reportVersions.id)
    .all();
  const lock = db.select().from(reportLocks).where(eq(reportLocks.matchId, matchId)).get() ?? null;
  const stl = db.select().from(settlements).where(eq(settlements.matchId, matchId)).orderBy(settlements.id).all();
  const oddsCount = db.select({ id: oddsSnapshots.id }).from(oddsSnapshots).where(eq(oddsSnapshots.matchId, matchId)).all().length;
  return {
    match,
    snapshots,
    oddsSnapshotCount: oddsCount,
    modelRuns: runs,
    reportVersions: versions,
    lock,
    settlements: stl.map((s) => ({
      id: s.id,
      result: s.settlementResult,
      roi: s.roi,
      clv: s.clv,
      brierScore: s.brierScore,
      opinion: JSON.parse(s.opinionJson) as unknown,
      settlementHash: s.settlementHash,
      settledAt: s.settledAt,
    })),
    chains: {
      model_run: verifyAuditChain("model_run"),
      report_version: verifyAuditChain("report_version"),
      report_lock: verifyAuditChain("report_lock"),
      settlement: verifyAuditChain("settlement"),
    },
  };
}
