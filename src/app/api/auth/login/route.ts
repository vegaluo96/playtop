import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { handleRoute, jsonErr, jsonOk } from "@/server/lib/api";
import { verifyPassword } from "@/server/auth/password";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clientIp, rateLimitClear, rateLimitHit } from "@/server/lib/rateLimit";

const inputSchema = z.object({ username: z.string(), password: z.string() });

/** 暴力破解防护：同一 IP+用户名 1 分钟内至多 5 次尝试 */
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;

export async function POST(req: Request) {
  return handleRoute(async () => {
    const { username, password } = inputSchema.parse(await req.json());
    const key = `login:${clientIp(req)}:${username}`;
    const rl = rateLimitHit(key, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!rl.ok) return jsonErr(429, `尝试过于频繁，请 ${rl.retryAfterSec} 秒后再试`);
    const user = db.select().from(users).where(eq(users.username, username)).get();
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return jsonErr(401, "用户名或密码错误");
    }
    if (user.status === "banned") return jsonErr(403, "账号已被禁用，请联系管理员");
    rateLimitClear(key); // 成功即清零失败计数
    const { token } = createSession(user.id);
    const res = jsonOk({ userId: user.id, username: user.username, role: user.role });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
    return res;
  });
}
