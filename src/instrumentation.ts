/** Next.js 启动钩子：迁移数据库 + 启动进程内调度器（globalThis 防 dev 模式重复注册） */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runMigrations } = await import("./server/db/migrate");
  runMigrations();
  const { bootstrapOnFirstRun } = await import("./server/db/bootstrap");
  await bootstrapOnFirstRun();
  const { startScheduler } = await import("./server/jobs/scheduler");
  startScheduler();
}
