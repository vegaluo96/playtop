/**
 * 历史赛果导入（本地交锋/近况统计底座，供 h2h、近期状态退化链使用）：
 *   npm run import-history                  # 俱乐部（启用联赛×3季）+ 国际赛（2018 起）
 *   npm run import-history -- --club        # 仅俱乐部
 *   npm run import-history -- --international --since 2014
 *   npm run import-history -- --seasons 5
 */
async function main() {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (f: string, d: number) => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
  };
  const doClub = has("--club") || !has("--international");
  const doIntl = has("--international") || !has("--club");

  const { runMigrations } = await import("../src/server/db/migrate");
  runMigrations();
  const { getConfig } = await import("../src/server/lib/config");
  const { importInternationalHistory, importLeagueHistory } = await import(
    "../src/server/services/importHistory"
  );

  if (doClub) {
    const leagues = getConfig("datasources").enabledLeagues;
    const seasons = val("--seasons", 3);
    console.log(`导入俱乐部联赛 ${leagues.join(",")} × ${seasons} 季…`);
    for (const code of leagues) {
      const r = await importLeagueHistory(code, seasons, true);
      for (const s of r) console.log(`  ${s.league}/${s.season}: +${s.inserted}（跳过 ${s.skipped}）`);
    }
  }
  if (doIntl) {
    const since = val("--since", 2018);
    console.log(`导入国际赛历史（${since} 年起，martj42/international_results）…`);
    const r = await importInternationalHistory(since, true);
    console.log(`  ${r.league}: +${r.inserted}（跳过 ${r.skipped}）`);
  }
  console.log("✓ 完成：历史赛果已入库（h2h / 近期状态本地统计底座）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
