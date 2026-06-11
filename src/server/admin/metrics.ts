/** 看板计数(metrics_daily,平台运营时区 UTC+8 对齐) */
import { db } from "../db";

export const day8 = (offset = 0, now = Date.now()) =>
  new Date(now + 8 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);

export function bump(k: string, n = 1, date = day8()): void {
  db()
    .prepare("INSERT INTO metrics_daily (date, k, n) VALUES (?,?,?) ON CONFLICT(date,k) DO UPDATE SET n = n + excluded.n")
    .run(date, k, n);
}

export function metric(k: string, date = day8()): number {
  const r = db().prepare("SELECT n FROM metrics_daily WHERE date = ? AND k = ?").get(date, k) as { n: number } | undefined;
  return r?.n ?? 0;
}

/** 当日按前缀取 TopN(热门场次 mv:<fid> 用) */
export function topMetrics(prefix: string, limit = 5, date = day8()): { k: string; n: number }[] {
  return db()
    .prepare("SELECT k, n FROM metrics_daily WHERE date = ? AND k LIKE ? ORDER BY n DESC LIMIT ?")
    .all(date, `${prefix}%`, limit) as unknown as { k: string; n: number }[];
}
