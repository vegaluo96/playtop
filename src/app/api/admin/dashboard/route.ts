import { count, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { auditLogs, historyMatches, matches, pointTransactions, unlocks, users } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { now } from "@/server/lib/time";
import { calibrationStats, recordOverview } from "@/server/services/stats";

export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    const dayStart = now() - 86_400_000;
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
    return jsonOk({
      statusCounts,
      todayUnlocks: todayUnlocks?.n ?? 0,
      todayPoints,
      userCount: userCount?.n ?? 0,
      historyCount: historyCount?.n ?? 0,
      record: recordOverview(null),
      calibration: calibrationStats(),
      recentAudit,
    });
  });
}
