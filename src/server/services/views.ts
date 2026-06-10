import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db";
import { analyses, leagues, matches, outcomes, teams, unlocks } from "../db/schema";
import { engineOutputSchema, type EngineOutput } from "../engine/types";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { ratingStars, selectionLabel, type LlmSections } from "../llm/reportWriter";
import { snapshotStats, type SnapshotStats } from "./snapshots";

/** 用户侧/页面渲染所需的查询封装（server components 直接调用） */

const home = alias(teams, "home_team");
const away = alias(teams, "away_team");

export interface MatchCard {
  id: number;
  league: string;
  round: string | null;
  homeName: string;
  awayName: string;
  kickoffAt: number;
  status: string;
  neutral: boolean;
  pricePoints: number | null;
  stars: string | null;
  verdict: string | null;
  version: number | null;
  snapshotTotal: number;
  unlocked: boolean;
  outcome: { homeGoals: number; awayGoals: number } | null;
}

function latestVisibleAnalysis(matchId: number) {
  return (
    db
      .select()
      .from(analyses)
      .where(and(eq(analyses.matchId, matchId), inArray(analyses.status, ["published", "public"])))
      .orderBy(desc(analyses.version))
      .limit(1)
      .get() ?? null
  );
}

/** 用户端可见的"赛前未发布"状态（卡片显示"研报准备中"，不泄漏内部状态机） */
export const UPCOMING_STATUSES = ["scheduled", "collecting", "ready", "analyzed"] as const;

export function listMatchCards(userId: number | null): MatchCard[] {
  const rows = db
    .select({ m: matches, league: leagues.name, homeName: home.name, awayName: away.name })
    .from(matches)
    .innerJoin(leagues, eq(leagues.id, matches.leagueId))
    .innerJoin(home, eq(home.id, matches.homeTeamId))
    .innerJoin(away, eq(away.id, matches.awayTeamId))
    .where(
      and(
        or(
          // 已发布/进行中/已结束：照旧
          inArray(matches.status, ["published", "in_play", "finished", "settled"]),
          // 未发布的未来赛程（世界杯等）：未来 14 天内也上首页，显示"研报准备中"
          and(
            inArray(matches.status, [...UPCOMING_STATUSES]),
            gte(matches.kickoffAt, now()),
            lte(matches.kickoffAt, now() + 14 * 86_400_000),
          ),
        ),
        gte(matches.kickoffAt, now() - 7 * 86_400_000),
      ),
    )
    .orderBy(matches.kickoffAt)
    .all();
  const unlockedSet = new Set(
    userId
      ? db
          .select({ matchId: unlocks.matchId })
          .from(unlocks)
          .where(eq(unlocks.userId, userId))
          .all()
          .map((r) => r.matchId)
      : [],
  );
  return rows.map(({ m, league, homeName, awayName }) => {
    const analysis = latestVisibleAnalysis(m.id);
    let stars: string | null = null;
    let verdict: string | null = null;
    let version: number | null = null;
    if (analysis) {
      const engine = engineOutputSchema.parse(JSON.parse(analysis.engineOutput));
      const r = ratingStars(engine);
      stars = r.stars;
      verdict = m.status === "settled" || unlockedSet.has(m.id) ? r.verdict : null;
      version = analysis.version;
    }
    const outcome = db.select().from(outcomes).where(eq(outcomes.matchId, m.id)).get() ?? null;
    return {
      id: m.id,
      league,
      round: m.round,
      homeName,
      awayName,
      kickoffAt: m.kickoffAt,
      status: m.status,
      neutral: m.neutral === 1,
      pricePoints: m.pricePoints ?? getConfig("pricing").defaultPricePoints,
      stars,
      verdict,
      version,
      snapshotTotal: snapshotStats(m.id).total,
      unlocked: unlockedSet.has(m.id),
      outcome: outcome && outcome.finalStatus === "finished" ? { homeGoals: outcome.homeGoals, awayGoals: outcome.awayGoals } : null,
    };
  });
}

export interface VersionInfo {
  analysisId: number;
  version: number;
  publishedAt: number | null;
  ensemble: { home: number; draw: number; away: number };
  contentHash: string | null;
}

export function versionHistory(matchId: number): VersionInfo[] {
  return db
    .select()
    .from(analyses)
    .where(and(eq(analyses.matchId, matchId), inArray(analyses.status, ["published", "public"])))
    .orderBy(desc(analyses.version))
    .all()
    .map((a) => {
      const engine = engineOutputSchema.parse(JSON.parse(a.engineOutput));
      return {
        analysisId: a.id,
        version: a.version,
        publishedAt: a.publishedAt,
        ensemble: engine.ensemble.probs,
        contentHash: a.contentHash,
      };
    });
}

/** 赛前未发布场次的赛程视图（"研报准备中"页用）；非未发布状态返回 null */
export function getUpcomingFixture(matchId: number): MatchCard | null {
  const row = db
    .select({ m: matches, league: leagues.name, homeName: home.name, awayName: away.name })
    .from(matches)
    .innerJoin(leagues, eq(leagues.id, matches.leagueId))
    .innerJoin(home, eq(home.id, matches.homeTeamId))
    .innerJoin(away, eq(away.id, matches.awayTeamId))
    .where(eq(matches.id, matchId))
    .get();
  if (!row || !(UPCOMING_STATUSES as readonly string[]).includes(row.m.status)) return null;
  return {
    id: row.m.id,
    league: row.league,
    round: row.m.round,
    homeName: row.homeName,
    awayName: row.awayName,
    kickoffAt: row.m.kickoffAt,
    status: row.m.status,
    neutral: row.m.neutral === 1,
    pricePoints: row.m.pricePoints ?? getConfig("pricing").defaultPricePoints,
    stars: null,
    verdict: null,
    version: null,
    snapshotTotal: snapshotStats(row.m.id).total,
    unlocked: false,
    outcome: null,
  };
}

export type MatchAccess = "locked" | "unlocked" | "public";

export interface MatchDetailView {
  card: MatchCard;
  access: MatchAccess;
  /** locked 时为 null */
  engine: EngineOutput | null;
  sections: LlmSections | null;
  reportMd: string | null;
  analysisId: number | null;
  publishedAt: number | null;
  contentHash: string | null;
  versions: VersionInfo[];
  snapshots: SnapshotStats;
  hoursBeforeKickoffPublished: number | null;
}

export function getMatchDetail(matchId: number, userId: number | null, isAdmin = false): MatchDetailView | null {
  const cards = listMatchCards(userId).filter((c) => c.id === matchId);
  let card = cards[0];
  if (!card) {
    // 不在默认列表窗口内（如更早的已结算比赛）：单独装配
    const row = db
      .select({ m: matches, league: leagues.name, homeName: home.name, awayName: away.name })
      .from(matches)
      .innerJoin(leagues, eq(leagues.id, matches.leagueId))
      .innerJoin(home, eq(home.id, matches.homeTeamId))
      .innerJoin(away, eq(away.id, matches.awayTeamId))
      .where(eq(matches.id, matchId))
      .get();
    if (!row || !["published", "in_play", "finished", "settled"].includes(row.m.status)) return null;
    const outcome = db.select().from(outcomes).where(eq(outcomes.matchId, matchId)).get() ?? null;
    card = {
      id: row.m.id,
      league: row.league,
      round: row.m.round,
      homeName: row.homeName,
      awayName: row.awayName,
      kickoffAt: row.m.kickoffAt,
      status: row.m.status,
      neutral: row.m.neutral === 1,
      pricePoints: row.m.pricePoints,
      stars: null,
      verdict: null,
      version: null,
      snapshotTotal: 0,
      unlocked: false,
      outcome:
        outcome && outcome.finalStatus === "finished"
          ? { homeGoals: outcome.homeGoals, awayGoals: outcome.awayGoals }
          : null,
    };
  }
  const analysis = latestVisibleAnalysis(matchId);
  if (!analysis) return null;
  const isPublic = card.status === "settled";
  const unlocked = card.unlocked || isAdmin;
  const access: MatchAccess = isPublic ? "public" : unlocked ? "unlocked" : "locked";
  const engine = engineOutputSchema.parse(JSON.parse(analysis.engineOutput));
  const stats = snapshotStats(matchId);
  const r = ratingStars(engine);
  card.stars = r.stars;
  if (access !== "locked") card.verdict = r.verdict;
  card.version = analysis.version;
  card.snapshotTotal = stats.total;
  const firstPublished = db
    .select({ publishedAt: analyses.publishedAt })
    .from(analyses)
    .where(and(eq(analyses.matchId, matchId), inArray(analyses.status, ["published", "public"])))
    .orderBy(analyses.version)
    .limit(1)
    .get();
  return {
    card,
    access,
    engine: access === "locked" ? null : engine,
    sections: access === "locked" ? null : analysis.llmSections ? (JSON.parse(analysis.llmSections) as LlmSections) : null,
    reportMd: access === "locked" ? null : analysis.reportMd,
    analysisId: analysis.id,
    publishedAt: analysis.publishedAt,
    contentHash: access === "locked" ? null : analysis.contentHash,
    versions: access === "locked" ? [] : versionHistory(matchId),
    snapshots: stats,
    hoursBeforeKickoffPublished: firstPublished?.publishedAt
      ? (card.kickoffAt - firstPublished.publishedAt) / 3_600_000
      : null,
  };
}

export { selectionLabel };
