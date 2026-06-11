/**
 * 平台闭环体检 CLI:
 *   npm run selfcheck                      # 全量 L0-L5(读 env ADMIN_EMAIL/PASSWORD 跑 L5)
 *   npm run selfcheck -- --llm             # 含 L6 大模型(消耗少量 tokens)
 *   npm run selfcheck -- --readonly        # 只读层 L0-L2(不打 HTTP、不写业务数据)
 *   npm run selfcheck -- --base http://localhost:3001
 *   npm run selfcheck -- audit <fixtureId> # 盘口保真度审计:AF原始→归一化→落库→显示 四层对照
 *   npm run selfcheck -- renorm [fid|all]  # 归一化修正后,重放 odds_raw 重建快照与异动
 * 退出码:有 ✗ 时为 2。
 */
import {
  auditOdds,
  renormalizeOdds,
  checkAdmin,
  checkApi,
  checkBusiness,
  checkLlm,
  checkReadonly,
  formatReport,
  summarize,
} from "../src/server/selfcheck";
import { kvSet } from "../src/server/af/store";
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
  if (args[0] === "audit") {
    const fid = Number(args[1]);
    if (!fid) {
      console.error("用法:npm run selfcheck -- audit <fixtureId>");
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
