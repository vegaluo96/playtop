import { and, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import { db } from "../db";
import { analyses, leagues, matches, outcomes, teams, unlocks } from "../db/schema";
import type {
  coachPayloadSchema,
  externalRatingsPayloadSchema,
  formPayloadSchema,
  h2hPayloadSchema,
  injuriesPayloadSchema,
  lineupsPayloadSchema,
  playerStatsPayloadSchema,
  refereePayloadSchema,
  softInfoPayloadSchema,
  standingsPayloadSchema,
  weatherPayloadSchema,
} from "../datasources/types";
import { engineOutputSchema, type EngineOutput } from "../engine/types";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { ratingStars, selectionLabel, type LlmSections } from "../llm/reportWriter";
import { snapshotBundle, snapshotPayload, snapshotStats, type SnapshotRow, type SnapshotStats } from "./snapshots";
import type { SnapshotKind } from "../db/schema";

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
  /** 免费公测：赛前观点全量公开（pricing.freeBeta） */
  freeBeta: boolean;
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
  const freeBeta = getConfig("pricing").freeBeta;
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
      verdict = m.status === "settled" || unlockedSet.has(m.id) || freeBeta ? r.verdict : null;
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
      freeBeta,
      outcome: outcome && outcome.finalStatus === "finished" ? { homeGoals: outcome.homeGoals, awayGoals: outcome.awayGoals } : null,
    };
  });
}

export interface VersionInfo {
  analysisId: number;
  version: number;
  publishedAt: number | null;
  createdAt: number;
  ensemble: { home: number; draw: number; away: number };
  /** 该版观点指纹（市场/方向/线/参考赔率）——用于"较上版变化"派生 */
  picks: { market: string; selection: string; line: number | null; odds: number | null }[];
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
        createdAt: a.createdAt,
        ensemble: engine.ensemble.probs,
        picks: engine.picks.map((p) => ({ market: p.market, selection: p.selection, line: p.line, odds: p.odds })),
        contentHash: a.contentHash,
      };
    });
}

/** 相邻两版之间的人话变化摘要（派生，零存储） */
export function versionDelta(cur: VersionInfo, prev: VersionInfo): string {
  const parts: string[] = [];
  const d = (cur.ensemble.home - prev.ensemble.home) * 100;
  if (Math.abs(d) >= 0.05) parts.push(`主胜概率${d > 0 ? "+" : ""}${d.toFixed(1)}pp`);
  const key = (v: VersionInfo) => v.picks.map((p) => `${p.market}:${p.selection}:${p.line}`).join("|");
  if (key(cur) !== key(prev)) {
    parts.push(cur.picks.length === 0 ? "转为观望" : prev.picks.length === 0 ? "由观望转出观点" : "观点方向调整");
  } else if (cur.picks.length > 0) {
    const o0 = prev.picks[0]?.odds;
    const o1 = cur.picks[0]?.odds;
    if (o0 && o1 && Math.abs(o1 - o0) >= 0.01) parts.push(`参考赔率 ${o0.toFixed(2)}→${o1.toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join("，") : "数据更新，结论不变";
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
    freeBeta: getConfig("pricing").freeBeta,
    outcome: null,
  };
}

export type MatchAccess = "locked" | "unlocked" | "public";

/** 比赛情报面板：抓取到的全部维度结构化展示（不再只进 AI 上下文与完备度计数） */
export interface MatchIntel {
  lineups: z.infer<typeof lineupsPayloadSchema> | null;
  injuries: z.infer<typeof injuriesPayloadSchema> | null;
  suspensions: z.infer<typeof injuriesPayloadSchema> | null;
  h2h: z.infer<typeof h2hPayloadSchema> | null;
  form: z.infer<typeof formPayloadSchema> | null;
  standings: z.infer<typeof standingsPayloadSchema> | null;
  playerStats: z.infer<typeof playerStatsPayloadSchema> | null;
  coach: z.infer<typeof coachPayloadSchema> | null;
  referee: z.infer<typeof refereePayloadSchema> | null;
  externalRatings: z.infer<typeof externalRatingsPayloadSchema> | null;
  weather: z.infer<typeof weatherPayloadSchema> | null;
  softInfo: z.infer<typeof softInfoPayloadSchema> | null;
}

function buildIntel(snaps: Map<SnapshotKind, SnapshotRow>): MatchIntel {
  const pay = <T,>(k: SnapshotKind) => snapshotPayload<T>(snaps.get(k));
  return {
    lineups: pay<z.infer<typeof lineupsPayloadSchema>>("lineups"),
    injuries: pay<z.infer<typeof injuriesPayloadSchema>>("injuries"),
    suspensions: pay<z.infer<typeof injuriesPayloadSchema>>("suspensions"),
    h2h: pay<z.infer<typeof h2hPayloadSchema>>("h2h"),
    form: pay<z.infer<typeof formPayloadSchema>>("form"),
    standings: pay<z.infer<typeof standingsPayloadSchema>>("standings"),
    playerStats: pay<z.infer<typeof playerStatsPayloadSchema>>("player_stats"),
    coach: pay<z.infer<typeof coachPayloadSchema>>("coach"),
    referee: pay<z.infer<typeof refereePayloadSchema>>("referee"),
    externalRatings: pay<z.infer<typeof externalRatingsPayloadSchema>>("external_ratings"),
    weather: pay<z.infer<typeof weatherPayloadSchema>>("weather"),
    softInfo: pay<z.infer<typeof softInfoPayloadSchema>>("soft_info"),
  };
}

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
  /** 比赛情报（locked 时为 null） */
  intel: MatchIntel | null;
  hoursBeforeKickoffPublished: number | null;
  /** 最低可接受赔率安全垫（决策卡渲染边界线用） */
  boundaryMargin: number;
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
      freeBeta: getConfig("pricing").freeBeta,
      outcome:
        outcome && outcome.finalStatus === "finished"
          ? { homeGoals: outcome.homeGoals, awayGoals: outcome.awayGoals }
          : null,
    };
  }
  const analysis = latestVisibleAnalysis(matchId);
  if (!analysis) return null;
  const isPublic = card.status === "settled";
  // 免费公测：赛前观点对所有人可读（含匿名）；关闭后恢复积分解锁
  const unlocked = card.unlocked || isAdmin || card.freeBeta;
  const access: MatchAccess = isPublic ? "public" : unlocked ? "unlocked" : "locked";
  const engine = engineOutputSchema.parse(JSON.parse(analysis.engineOutput));
  // 一次查询同出完备度与每 kind 最新（避免 stats + intel 双倍全表扫描）
  const { stats, latest } = snapshotBundle(matchId);
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
    intel: access === "locked" ? null : buildIntel(latest),
    hoursBeforeKickoffPublished: firstPublished?.publishedAt
      ? (card.kickoffAt - firstPublished.publishedAt) / 3_600_000
      : null,
    boundaryMargin: getConfig("engine").boundaryMargin,
  };
}

export { selectionLabel };
