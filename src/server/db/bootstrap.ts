import { count } from "drizzle-orm";
import { db } from "./index";
import { users } from "./schema";
import { hashPassword } from "../auth/password";
import { getConfig, setConfig } from "../lib/config";
import { now } from "../lib/time";
import { ensureLeague } from "../services/teamResolver";

/** 首次启动自举：无任何用户时创建管理员（ADMIN_USERNAME/ADMIN_PASSWORD 可覆盖默认值） */
export async function bootstrapOnFirstRun(): Promise<void> {
  const n = db.select({ n: count() }).from(users).get()?.n ?? 0;
  if (n === 0) {
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin123456";
    db.insert(users)
      .values({ username, passwordHash: await hashPassword(password), role: "admin", points: 0, createdAt: now() })
      .run();
    console.log(`[bootstrap] 管理员账号已创建：${username}（默认密码请尽快修改）`);
  }
  for (const key of ["apiyi", "datasources", "engine", "pricing", "automation"] as const) {
    setConfig(key, getConfig(key));
  }
  ensureLeague("INT");
  const { seedProviders } = await import("../v2/providers");
  seedProviders();
}
