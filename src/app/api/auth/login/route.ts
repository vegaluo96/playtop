import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { handleRoute, jsonErr, jsonOk } from "@/server/lib/api";
import { verifyPassword } from "@/server/auth/password";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";

const inputSchema = z.object({ username: z.string(), password: z.string() });

export async function POST(req: Request) {
  return handleRoute(async () => {
    const { username, password } = inputSchema.parse(await req.json());
    const user = db.select().from(users).where(eq(users.username, username)).get();
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return jsonErr(401, "用户名或密码错误");
    }
    if (user.status === "banned") return jsonErr(403, "账号已被禁用，请联系管理员");
    const { token } = createSession(user.id);
    const res = jsonOk({ userId: user.id, username: user.username, role: user.role });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 30 * 86_400,
      path: "/",
      secure: process.env.COOKIE_SECURE === "1",
    });
    return res;
  });
}
