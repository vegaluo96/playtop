import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/server/db";
import { auditLogs, historyMatches, leagues, matches, outcomes, pointTransactions, teams, unlocks, users } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { getConfig } from "@/server/lib/config";
import { now } from "@/server/lib/time";
import { readJobHeartbeats } from "@/server/jobs/scheduler";
import { SOURCE_REGISTRY } from "@/server/datasources/registry";
import { listSourceHealth } from "@/server/services/sourceHealth";
import { calibrationStats, recordOverview } from "@/server/services/stats";
import { UPCOMING_STATUSES } from "@/server/services/views";

const home = alias(teams, "dash_home");
const away = alias(teams, "dash_away");

function matchSelect() {
  return db
    .select({
      id: matches.id,
      league: leagues.name,
      round: matches.round,
      homeName: home.name,
      awayName: away.name,
      kickoffAt: matches.kickoffAt,
      status: matches.status,
    })
    .from(matches)
    .innerJoin(leagues, eq(leagues.id, matches.leagueId))
    .innerJoin(home, eq(home.id, matches.homeTeamId))
    .innerJoin(away, eq(away.id, matches.awayTeamId));
}

export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    const t = now();
    const dayStart = t - 86_400_000;
    const statusCounts = db
      .select({ status: matches.status, n: count() })
      .from(matches)
      .groupBy(matches.status)
      .all();
    const todayUnlocks = db.select({ n: count() }).from(unlocks).where(gte(unlocks.createdAt, dayStart)).get();
    const todayPoints = db
      .select({ granted: sql<number>`coalesce(sum(case when delta > 0 then delta else 0 end), 0)`, spent: sql<number>`coalesce(sum(case when type = 'unlock' then -delta else 0 end), 0)` })
      .from(pointTransactions)
      .where(gte(pointTransactions.createdAt, dayStart))
      .get();
    const userCount = db.select({ n: count() }).from(users).get();
    const historyCount = db.select({ n: count() }).from(historyMatches).get();
    const recentAudit = db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(30).all();

    // ── 值班台核心：需要人工的异常队列 ──────────────────────────────
    // 1) AI 赛果待确认
    const pendingOutcomes = db
      .select({
        matchId: outcomes.matchId,
        homeGoals: outcomes.homeGoals,
        awayGoals: outcomes.awayGoals,
        source: outcomes.source,
        recordedAt: outcomes.recordedAt,
        homeName: home.name,
        awayName: away.name,
      })
      .from(outcomes)
      .innerJoin(matches, eq(matches.id, outcomes.matchId))
      .innerJoin(home, eq(home.id, matches.homeTeamId))
      .innerJoin(away, eq(away.id, matches.awayTeamId))
      .where(eq(outcomes.provisional, 1))
      .all();
    // 2) 临近开球（12h 内）仍未发布——管道卡壳信号
    const stuck = matchSelect()
      .where(
        and(
          inArray(matches.status, [...UPCOMING_STATUSES]),
          gte(matches.kickoffAt, t),
          lte(matches.kickoffAt, t + 12 * 3_600_000),
        ),
      )
      .orderBy(matches.kickoffAt)
      .all();
    // 3) 完场超时（开球 3.5h 后）仍无任何赛果
    const staleInPlay = matchSelect()
      .where(and(eq(matches.status, "in_play"), lte(matches.kickoffAt, t - 3.5 * 3_600_000)))
      .orderBy(matches.kickoffAt)
      .all()
      .filter((m) => !db.select().from(outcomes).where(eq(outcomes.matchId, m.id)).get());
    // 4) 数据源连败/停用
    const threshold = getConfig("datasources").sourceAutoDisableAfter;
    const labelOf = (key: string) => SOURCE_REGISTRY.find((s) => s.key === key)?.label ?? key;
    const sourceIssues = listSourceHealth()
      .filter((r) => r.consecutiveFails >= Math.max(2, Math.min(3, threshold || 3)))
      .map((r) => ({
        source: r.source,
        label: labelOf(r.source),
        consecutiveFails: r.consecutiveFails,
        lastError: r.lastError,
        disabled: threshold > 0 && r.consecutiveFails >= threshold,
      }))
      .sort((a, b) => Number(b.disabled) - Number(a.disabled) || b.consecutiveFails - a.consecutiveFails);

    // 今日窗口：过去 6h ~ 未来 24h 开球的场次（值班视野）
    const todayMatches = matchSelect()
      .where(and(gte(matches.kickoffAt, t - 6 * 3_600_000), lte(matches.kickoffAt, t + 24 * 3_600_000)))
      .orderBy(matches.kickoffAt)
      .all();

    return jsonOk({
      statusCounts,
      todayUnlocks: todayUnlocks?.n ?? 0,
      todayPoints,
      userCount: userCount?.n ?? 0,
      historyCount: historyCount?.n ?? 0,
      record: recordOverview(null),
      calibration: calibrationStats(),
      recentAudit,
      heartbeats: readJobHeartbeats(),
      attention: { pendingOutcomes, stuck, staleInPlay, sourceIssues },
      todayMatches,
      automation: getConfig("automation"),
    });
  });
}
