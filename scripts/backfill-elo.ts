async function main() {
  const { runMigrations } = await import("../src/server/db/migrate");
  runMigrations();
  const { backfillElo } = await import("../src/server/services/eloService");
  console.log(`✓ Elo 全量回放完成：${backfillElo()} 场`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
