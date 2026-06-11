import cron from "node-cron";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { dataSnapshots, settings } from "../db/schema";
import { now } from "../lib/time";
import { advanceMatch } from "../services/automation";
import { collectMatch } from "../services/collect";
import { importWorldCupFixtures } from "../services/importWorldCup";
import { matchesByStatus, syncFixtures } from "../services/matchesService";
import { autoConfirmDueOutcomes, lockFinalAnalysisAtKickoff, settleDueMatches } from "../services/settle";
import { getConfig } from "../lib/config";
import { fetchResultsFromApiFootball, fetchResultsFromCsv, fetchResultsViaAi } from "./fetchResults";

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

export async function tickStateMachine(): Promise<{ confirmed: number; locked: number; settled: number; nearRefreshed: number }> {
  const confirmed = autoConfirmDueOutcomes(); // delay 策略的自动确认（double_check 在赛果抓取时即时处理）
  const locked = lockFinalAnalysisAtKickoff();
  const settled = settleDueMatches();
  // 临场加密刷新：开球前 6h 内已发布场次，10 分钟级只刷盘口+官方首发——
  // 价差监测/边界线的时效窗口；其余维度仍走 30 分钟主循环
  let nearRefreshed = 0;
  const near = matchesByStatus(["published"]).filter((m) => m.kickoffAt > now() && m.kickoffAt - now() < 6 * 3_600_000);
  for (const m of near) {
    try {
      await collectMatch(m.id, { oddsOnly: true, skipAi: true });
      await advanceMatch(m.id);
      nearRefreshed++;
    } catch (e) {
      console.warn(`[jobs] 临场刷新失败 match=${m.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { confirmed, locked, settled, nearRefreshed };
}

/** 全自动核心循环：采集 → 建模 → 发布 → 改版，全链路由 advanceMatch 推进（断头修复点） */
export async function tickLiveRevisions(): Promise<{ refreshed: number; advanced: number }> {
  let refreshed = 0;
  let advanced = 0;
  const auto = getConfig("automation");
  try {
    await syncFixtures(false); // 刷新全部盘口（内容哈希去重）
  } catch (e) {
    console.warn("[jobs] fixtures 刷新失败:", e instanceof Error ? e.message : e);
  }
  // scheduled 也纳入：自动建赛的场次临近开球时自动采集，并一路推进到发布（窗口可配置）
  const windowMs = auto.pipelineWindowHours * 3_600_000;
  const live = matchesByStatus(["published", "analyzed", "ready", "scheduled", "collecting"]).filter(
    (m) => m.kickoffAt > now() && m.kickoffAt - now() < windowMs,
  );
  for (const m of live) {
    try {
      if (auto.autoCollect) {
        const skipAi = latestLlmSnapshotAge(m.id) < AI_REFRESH_INTERVAL;
        await collectMatch(m.id, { skipAi });
        refreshed++;
      }
      const steps = await advanceMatch(m.id);
      if (steps.length > 0) advanced++;
    } catch (e) {
      console.warn(`[jobs] 自动推进失败 match=${m.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return { refreshed, advanced };
}

export async function tickResults(): Promise<{ apiFootball: number; csv: number; ai: number }> {
  const apiFootball = await fetchResultsFromApiFootball().catch(() => 0); // 付费主源，最先
  const csv = await fetchResultsFromCsv().catch(() => 0);
  const ai = await fetchResultsViaAi().catch(() => 0); // 兜底
  return { apiFootball, csv, ai };
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

export interface JobHeartbeat {
  at: number;
  ok: boolean;
  note: string;
}

/** 任务心跳：每次执行落 settings（值班台据此回答"自动化还活着吗"）；心跳失败绝不影响任务本身 */
function recordHeartbeat(name: string, ok: boolean, note: string): void {
  try {
    const key = "job_heartbeat";
    const row = db.select().from(settings).where(eq(settings.key, key)).get();
    const cur: Record<string, JobHeartbeat> = row ? JSON.parse(row.value) : {};
    cur[name] = { at: now(), ok, note: note.slice(0, 200) };
    db.insert(settings)
      .values({ key, value: JSON.stringify(cur), updatedAt: now() })
      .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(cur), updatedAt: now() } })
      .run();
  } catch {
    /* noop */
  }
}

export function readJobHeartbeats(): Record<string, JobHeartbeat> {
  const row = db.select().from(settings).where(eq(settings.key, "job_heartbeat")).get();
  return row ? (JSON.parse(row.value) as Record<string, JobHeartbeat>) : {};
}

async function guarded(name: string): Promise<void> {
  if (running.has(name)) return;
  running.add(name);
  try {
    const r = await JOBS[name]();
    recordHeartbeat(name, true, JSON.stringify(r ?? ""));
  } catch (e) {
    console.error(`[jobs] ${name} 异常:`, e);
    recordHeartbeat(name, false, e instanceof Error ? e.message : String(e));
  } finally {
    running.delete(name);
  }
}

export function startScheduler(): void {
  if (g.__playtopCron) return;
  g.__playtopCron = true;
  cron.schedule("*/10 * * * *", () => void guarded("state_machine"));
  cron.schedule("*/30 * * * *", () => void guarded("live_revisions"));
  cron.schedule("15 */2 * * *", () => void guarded("fetch_results")); // 2h：double_check 两次一致约 4-5h 内自动结算
  cron.schedule("45 */6 * * *", () => void guarded("sync_fixtures"));
  // 冷启动即开跑：部署后无需任何人工——先同步赛程（世界杯/联赛自动建赛），再立即推进窗口内场次
  setTimeout(() => void guarded("sync_fixtures"), 5_000);
  setTimeout(() => void guarded("live_revisions"), 30_000);
  setTimeout(() => void guarded("state_machine"), 60_000);
  console.log("[jobs] 调度器已启动（状态机 10m / 自动推进 30m / 赛果 2h / 赛程同步 6h；冷启动自动开跑）");
}

/** 管理端手动触发（演示/补偿）——同样记心跳 */
export async function runJobNow(name: string): Promise<unknown> {
  const job = JOBS[name];
  if (!job) throw new Error(`未知任务：${name}（可选：${Object.keys(JOBS).join("/")}）`);
  try {
    const r = await job();
    recordHeartbeat(name, true, JSON.stringify(r ?? ""));
    return r;
  } catch (e) {
    recordHeartbeat(name, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
