import { eq } from "drizzle-orm";

async function main() {
  const { runMigrations } = await import("../src/server/db/migrate");
  runMigrations();
  const { db } = await import("../src/server/db");
  const { users } = await import("../src/server/db/schema");
  const { hashPassword } = await import("../src/server/auth/password");
  const { ensureLeague } = await import("../src/server/services/teamResolver");
  const { setConfig, getConfig } = await import("../src/server/lib/config");
  const { now } = await import("../src/server/lib/time");

  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD ?? "admin123456";
  const existing = db.select().from(users).where(eq(users.username, username)).get();
  if (!existing) {
    db.insert(users)
      .values({
        username,
        passwordHash: await hashPassword(password),
        role: "admin",
        points: 0,
        createdAt: now(),
      })
      .run();
    console.log(`✓ 管理员账号已创建：${username} / ${password}（请尽快登录后台修改 apiyi 配置，并更换默认密码）`);
  } else {
    console.log(`· 管理员账号已存在：${username}`);
  }

  // 持久化全部缺省配置（便于后台直接查看/修改）
  for (const key of ["apiyi", "datasources", "engine", "pricing"] as const) {
    setConfig(key, getConfig(key));
  }
  ensureLeague("INT");
  console.log("✓ 缺省配置与国际赛事联赛已就绪");
  console.log("下一步：npm run import-history（导入历史样本喂模型）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
