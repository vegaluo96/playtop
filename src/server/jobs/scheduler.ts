import cron from "node-cron";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { dataSnapshots } from "../db/schema";
import { now } from "../lib/time";
import { analyzeMatch } from "../services/analyze";
import { collectMatch } from "../services/collect";
import { importWorldCupFixtures } from "../services/importWorldCup";
import { matchesByStatus, syncFixtures } from "../services/matchesService";
import { lockFinalAnalysisAtKickoff, settleDueMatches } from "../services/settle";
import { fetchResultsFromCsv, fetchResultsViaAi } from "./fetchResults";

/**
 * 进程内调度（单体部署，无外部队列）：
 * - 每 10 分钟：状态机推进（开赛锁定终版 → 结算公开）
 * - 每 30 分钟：实时改版引擎——对 48h 内已发布比赛重新采集 + 重算 + 自动发布新版
 * - 每 6 小时：赛果回填（CSV 权威 + AI provisional）
 * - 每 6 小时：赛程同步——联赛 CSV + 世界杯（openfootball）自动建赛/补建淘汰赛
 * 所有任务有 isRunning 互斥，避免重入。
 */

const AI_REFRESH_INTERVAL = 6 * 3_600_000; // AI 检索每场至多 6 小时一次（控制 token 成本）

function latestLlmSnapshotAge(matchId: number): number {
  const row = db
    .select({ fetchedAt: dataSnapshots.fetchedAt })
    .from(dataSnapshots)
    .where(and(eq(dataSnapshots.matchId, matchId), eq(dataSnapshots.source, "llm")))
    .orderBy(desc(dataSnapshots.fetchedAt))
    .limit(1)
    .get();
  return row ? now() - row.fetchedAt : Infinity;
}

export async function tickStateMachine(): Promise<{ locked: number; settled: number }> {
  const locked = lockFinalAnalysisAtKickoff();
  const settled = settleDueMatches();
  return { locked, settled };
}

/** 实时改版核心循环：数据更新 → 引擎重算 → 自动发布新版本 */
export async function tickLiveRevisions(): Promise<{ refreshed: number; revised: number }> {
  let refreshed = 0;
  let revised = 0;
  try {
    await syncFixtures(false); // 刷新全部盘口（内容哈希去重）
  } catch (e) {
    console.warn("[jobs] fixtures 刷新失败:", e instanceof Error ? e.message : e);
  }
  // scheduled 也纳入：自动建赛的场次临近开球时自动采集，推进到"数据就绪"等待建模
  const live = matchesByStatus(["published", "analyzed", "ready", "scheduled", "collecting"]).filter(
    (m) => m.kickoffAt > now() && m.kickoffAt - now() < 48 * 3_600_000,
  );
  for (const m of live) {
    try {
      const skipAi = latestLlmSnapshotAge(m.id) < AI_REFRESH_INTERVAL;
      await collectMatch(m.id, { skipAi });
      refreshed++;
      if (m.status === "published") {
        const r = await analyzeMatch(m.id, { autoPublishRevision: true });
        if (r.changed) revised++;
      }
    } catch (e) {
      console.warn(`[jobs] 实时改版失败 match=${m.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { refreshed, revised };
}

export async function tickResults(): Promise<{ csv: number; ai: number }> {
  const csv = await fetchResultsFromCsv().catch(() => 0);
  const ai = await fetchResultsViaAi().catch(() => 0);
  return { csv, ai };
}

/** 赛程同步：联赛 CSV 自动建赛 + 世界杯增量同步（淘汰赛对阵确定后自动补建） */
export async function tickFixtureSync(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    out.club = await syncFixtures(true);
  } catch (e) {
    out.club = `失败：${e instanceof Error ? e.message : e}`;
  }
  try {
    out.worldCup = await importWorldCupFixtures();
  } catch (e) {
    out.worldCup = `失败：${e instanceof Error ? e.message : e}`;
  }
  return out;
}

export const JOBS: Record<string, () => Promise<unknown>> = {
  state_machine: tickStateMachine,
  live_revisions: tickLiveRevisions,
  fetch_results: tickResults,
  sync_fixtures: tickFixtureSync,
};

const g = globalThis as unknown as { __playtopCron?: boolean };
const running = new Set<string>();

async function guarded(name: string): Promise<void> {
  if (running.has(name)) return;
  running.add(name);
  try {
    await JOBS[name]();
  } catch (e) {
    console.error(`[jobs] ${name} 异常:`, e);
  } finally {
    running.delete(name);
  }
}

export function startScheduler(): void {
  if (g.__playtopCron) return;
  g.__playtopCron = true;
  cron.schedule("*/10 * * * *", () => void guarded("state_machine"));
  cron.schedule("*/30 * * * *", () => void guarded("live_revisions"));
  cron.schedule("15 */6 * * *", () => void guarded("fetch_results"));
  cron.schedule("45 */6 * * *", () => void guarded("sync_fixtures"));
  console.log("[jobs] 调度器已启动（状态机 10m / 实时改版 30m / 赛果 6h / 赛程同步 6h）");
}

/** 管理端手动触发（演示/补偿） */
export async function runJobNow(name: string): Promise<unknown> {
  const job = JOBS[name];
  if (!job) throw new Error(`未知任务：${name}（可选：${Object.keys(JOBS).join("/")}）`);
  return job();
}
