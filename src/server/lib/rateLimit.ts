import { now } from "./time";

/**
 * 进程内固定窗口限速（单体部署，无外部依赖）。
 * 登录等敏感端点用：按 key（IP+用户名）计失败次数，超阈值在窗口内拒绝。
 * 成功后调用 clear 重置。内存 Map 足够单进程；过期条目惰性清理。
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec: number;
}

export function rateLimitHit(key: string, limit: number, windowMs: number): RateLimitResult {
  const t = now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= t) {
    buckets.set(key, { count: 1, resetAt: t + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  b.count++;
  if (b.count > limit) return { ok: false, retryAfterSec: Math.ceil((b.resetAt - t) / 1000) };
  return { ok: true, retryAfterSec: 0 };
}

export function rateLimitClear(key: string): void {
  buckets.delete(key);
}

/** 取客户端 IP（Caddy 反代注入 x-forwarded-for；取第一跳） */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 仅测试用：清空全部桶 */
export function _resetRateLimitForTest(): void {
  buckets.clear();
}
