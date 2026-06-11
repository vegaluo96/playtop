import { z } from "zod";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { handleRoute, jsonErr, jsonOk } from "@/server/lib/api";
import { now } from "@/server/lib/time";
import { hashPassword } from "@/server/auth/password";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";

const inputSchema = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_一-龥]{2,20}$/, "用户名 2-20 位，支持中英文/数字/下划线"),
  password: z.string().min(6, "密码至少 6 位").max(72),
});

export async function POST(req: Request) {
  return handleRoute(async () => {
    const { username, password } = inputSchema.parse(await req.json());
    const passwordHash = await hashPassword(password);
    let userId: number;
    try {
      userId = db
        .insert(users)
        .values({ username, passwordHash, role: "user", points: 0, createdAt: now() })
        .returning({ id: users.id })
        .get().id;
    } catch (e) {
      if (e instanceof Error && /UNIQUE/.test(e.message)) return jsonErr(409, "用户名已被占用");
      throw e;
    }
    const { token } = createSession(userId);
    const res = jsonOk({ userId, username });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
    return res;
  });
}
