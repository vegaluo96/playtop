/**
 * 平台闭环体检 CLI:
 *   npm run selfcheck                      # 全量 L0-L5(读 env ADMIN_EMAIL/PASSWORD 跑 L5)
 *   npm run selfcheck -- --llm             # 含 L6 大模型(消耗少量 tokens)
 *   npm run selfcheck -- --readonly        # 只读层 L0-L2(不打 HTTP、不写业务数据)
 *   npm run selfcheck -- --base http://localhost:3001
 *   npm run selfcheck -- audit <fixtureId> # 盘口保真度审计:AF原始→归一化→落库→显示 四层对照
 *   npm run selfcheck -- verify [n]        # 批量校验未来48h全部场次主盘 vs AF源,自动判定 ✓/△/✗
 *   npm run selfcheck -- renorm [fid|all]  # 归一化修正后,重放 odds_raw 重建快照与异动
 * 退出码:有 ✗ 时为 2。
 */
import {
  auditOdds,
  verifyOdds,
  renormalizeOdds,
  checkAdmin,
  checkApi,
  checkBusiness,
  checkLlm,
  checkReadonly,
  formatReport,
  summarize,
} from "../src/server/selfcheck";
import { fixturesBetween, kvSet } from "../src/server/af/store";
import { isFinished } from "../src/server/af/schedule";
import { loadEnvFile } from "../src/server/env-file";

async function main() {
  if (loadEnvFile()) console.log("已加载 /srv/playtop.env(与 pm2 同源)");
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : `http://127.0.0.1:${process.env.PORT || 3000}`;

  if (args[0] === "renorm") {
    const fid = args[1] && args[1] !== "all" ? Number(args[1]) : undefined;
    const r = renormalizeOdds(fid);
    console.log(`重算完成:${r.fixtures} 场 · 重放 ${r.raws} 帧原始数据 · 重建异动 ${r.moves} 条`);
    return;
  }
  if (args[0] === "verify") {
    console.log(await verifyOdds(Number(args[1]) || 20));
    return;
  }
  if (args[0] === "audit") {
    // audit <fixtureId> 单场;audit upcoming [n] 自动审计最近 n 场即将开赛(默认 3)
    if (args[1] === "upcoming" || args[1] === "next") {
      const n = Number(args[2]) || 3;
      const now = Date.now();
      const all = fixturesBetween(now - 2 * 3_600_000, now + 14 * 24 * 3_600_000)
        .filter((f) => !isFinished(f.status))
        .sort((a, b) => a.kickoff_utc - b.kickoff_utc)
        .slice(0, n);
      if (all.length === 0) {
        console.log("近期无未完场赛事可审计。");
        return;
      }
      for (const f of all) {
        console.log(`\n${"═".repeat(64)}\n${f.home_name} vs ${f.away_name} · fixture=${f.fixture_id} · 开球 ${new Date(f.kickoff_utc + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ")}(UTC+8)`);
        console.log(await auditOdds(f.fixture_id, base));
      }
      return;
    }
    const fid = Number(args[1]);
    if (!fid) {
      console.error("用法:npm run selfcheck -- audit <fixtureId>  |  audit upcoming [场数]");
      process.exit(1);
    }
    console.log(await auditOdds(fid, base));
    return;
  }

  console.log(`平台闭环体检 · base=${base}\n`);
  const rows = await checkReadonly();
  if (!args.includes("--readonly")) {
    rows.push(...(await checkApi(base)));
    rows.push(...(await checkBusiness(base)));
    rows.push(...(await checkAdmin(base)));
    if (args.includes("--llm")) rows.push(...(await checkLlm()));
  }
  const rep = summarize(rows);
  console.log(formatReport(rep));
  kvSet("last_platform_check", JSON.stringify({ at: rep.at, ...rep.summary }));
  if (rep.summary.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
