import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import { sha256Hex } from "../lib/hash";
import { now } from "../lib/time";

export const SESSION_COOKIE = "pt_session";
const SESSION_TTL = 30 * 86_400_000; // 30 天，活动即顺延

/** 会话 cookie 选项：生产环境恒 secure（Caddy 终结 HTTPS）；COOKIE_SECURE=1 可显式开启 */
export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 30 * 86_400,
  path: "/",
  secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1",
};

export function createSession(userId: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("hex");
  const expiresAt = now() + SESSION_TTL;
  db.insert(sessions)
    .values({ tokenHash: sha256Hex(token), userId, expiresAt, createdAt: now() })
    .run();
  // 顺手清理过期 session
  db.delete(sessions).where(lt(sessions.expiresAt, now())).run();
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token))).run();
}

export type SessionUser = typeof users.$inferSelect;

export function getSessionUser(token: string): SessionUser | null {
  const tokenHash = sha256Hex(token);
  const row = db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now())))
    .get();
  if (!row) return null;
  // 滑动过期：剩余不足 25 天时顺延
  if (row.expiresAt - now() < 25 * 86_400_000) {
    db.update(sessions)
      .set({ expiresAt: now() + SESSION_TTL })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
  }
  return row.user;
}
