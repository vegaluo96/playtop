import { eq } from "drizzle-orm";
import { db } from "../db";
import { sourceHealth } from "../db/schema";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";

/**
 * 数据源健康账本：每次抓取记成败；连败达阈值（datasources.sourceAutoDisableAfter）
 * 自动停用——采集管道跳过该源（"抓不到的源自动清除"），体检/任意一次成功自动复活。
 */

export function reportSourceOk(source: string): void {
  const row = db.select().from(sourceHealth).where(eq(sourceHealth.source, source)).get();
  if (row) {
    db.update(sourceHealth)
      .set({ okCount: row.okCount + 1, consecutiveFails: 0, lastOkAt: now() })
      .where(eq(sourceHealth.source, source))
      .run();
  } else {
    db.insert(sourceHealth).values({ source, okCount: 1, lastOkAt: now() }).run();
  }
}

export function reportSourceFail(source: string, error: string): void {
  const msg = error.slice(0, 300);
  const row = db.select().from(sourceHealth).where(eq(sourceHealth.source, source)).get();
  if (row) {
    db.update(sourceHealth)
      .set({
        failCount: row.failCount + 1,
        consecutiveFails: row.consecutiveFails + 1,
        lastErrorAt: now(),
        lastError: msg,
      })
      .where(eq(sourceHealth.source, source))
      .run();
  } else {
    db.insert(sourceHealth).values({ source, failCount: 1, consecutiveFails: 1, lastErrorAt: now(), lastError: msg }).run();
  }
}

/** 源是否可用：开关开启 且 未触发连败自动停用 */
export function isSourceUsable(source: string, enabled: boolean): boolean {
  if (!enabled) return false;
  const threshold = getConfig("datasources").sourceAutoDisableAfter;
  if (threshold <= 0) return true;
  const row = db.select().from(sourceHealth).where(eq(sourceHealth.source, source)).get();
  return !row || row.consecutiveFails < threshold;
}

/** 包一层成败上报：软未命中（返回 null/false）计成功——源可达即健康 */
export async function withSource<T>(source: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    reportSourceOk(source);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 进程内礼貌冷却 ≠ 源故障：不计成败，避免多任务撞冷却误触发自动停用
    if (!/抓取过于频繁/.test(msg)) reportSourceFail(source, msg);
    throw e;
  }
}

export function listSourceHealth() {
  return db.select().from(sourceHealth).all();
}
