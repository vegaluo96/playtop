/**
 * 进程内令牌桶限速(IP+桶名)+ 登录失败锁定。
 * 单机 pm2 部署下进程内状态足够;nginx 前置须传 X-Forwarded-For。
 * 超限/锁定写 risk_queue(dedup 防刷屏),风控页可见。
 */
import type { NextRequest } from "next/server";
import { db } from "../db";

interface Bucket {
  tokens: number;
  last: number;
}
const buckets = new Map<string, Bucket>();
const fails = new Map<string, { n: number; first: number }>();

export function clientIp(req: NextRequest): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
}

/** 令牌桶:windowMs 内最多 n 次;超限返回 false */
export function rateLimit(req: NextRequest, bucket: string, n: number, windowMs: number): boolean {
  const key = `${clientIp(req)}|${bucket}`;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: n, last: now };
  b.tokens = Math.min(n, b.tokens + ((now - b.last) / windowMs) * n);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    riskNote(`限速:${bucket}`, `${clientIp(req)} 触发 ${bucket} 限速(${n}/${Math.round(windowMs / 1000)}s)`, `rl:${key}:${new Date(now).toISOString().slice(0, 13)}`);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

const LOCK_N = 5;
const LOCK_WINDOW = 15 * 60_000;

/** 登录失败计数(邮箱+IP):15 分钟 5 次 → 锁定剩余窗口 */
export function loginLocked(email: string, ip: string): boolean {
  const f = fails.get(`${email}|${ip}`);
  return !!f && f.n >= LOCK_N && Date.now() - f.first < LOCK_WINDOW;
}

export function recordLoginFail(email: string, ip: string): void {
  const key = `${email}|${ip}`;
  const now = Date.now();
  const f = fails.get(key);
  if (!f || now - f.first >= LOCK_WINDOW) {
    fails.set(key, { n: 1, first: now });
    return;
  }
  f.n += 1;
  if (f.n === LOCK_N)
    riskNote("登录锁定", `${email}(${ip})15 分钟内连续 ${LOCK_N} 次密码错误,已临时锁定`, `lock:${key}:${new Date(now).toISOString().slice(0, 10)}`);
}

export function clearLoginFails(email: string, ip: string): void {
  fails.delete(`${email}|${ip}`);
}

function riskNote(type: string, detail: string, dedup: string): void {
  try {
    db()
      .prepare("INSERT OR IGNORE INTO risk_queue (at, type, score, detail, dedup) VALUES (?,?,?,?,?)")
      .run(Date.now(), type, 60, detail, dedup);
  } catch {
    /* 风控记录失败不阻断主流程 */
  }
}

/** 同源断言:变更类请求 Origin/Referer 必须属于本站(SameSite=Lax 之外的纵深防御) */
export function sameOrigin(req: NextRequest, siteHost: string): boolean {
  const src = req.headers.get("origin") ?? req.headers.get("referer");
  if (!src) return true; // 无头(curl/旧客户端)放行,主防线仍是 SameSite cookie
  try {
    const h = new URL(src).hostname;
    return h === siteHost || h === `www.${siteHost}` || h === `admin.${siteHost}` || h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}

/** 仅测试用 */
export function _resetRateLimitForTest(): void {
  buckets.clear();
  fails.clear();
}
