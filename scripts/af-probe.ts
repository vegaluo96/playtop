/**
 * AF 数据层 CLI（设计定稿前的查数/排障工具，无需任何 UI）：
 *   npm run af                         # 目录：全部端点
 *   npm run af -- status               # 账户与配额
 *   npm run af -- fixtures date=2026-06-11 league=39
 *   npm run af -- teams.statistics team=33 league=39 season=2025
 *   npm run af -- selftest             # 真机自检：39 端点各打一枪 + 配额消耗
 *   npm run af -- selftest league=39 season=2023 delay=7000   # 限流套餐调大 delay
 * 需要服务器 env API_FOOTBALL_KEY。
 */
import { afConfigured } from "../src/server/af/client";
import { AF_ENDPOINTS, afCatalogGrouped, runAfEndpoint } from "../src/server/af/catalog";
import { runSelftest, formatSelftest } from "../src/server/af/selftest";

async function main() {
  const [key, ...rest] = process.argv.slice(2);
  if (!key) {
    console.log(`API-Football v3 端点目录（共 ${AF_ENDPOINTS.length} 个）：\n`);
    for (const g of afCatalogGrouped()) {
      console.log(`■ ${g.group}`);
      for (const e of g.endpoints) {
        const req = e.params.filter((p) => p.required).map((p) => p.name + "*");
        const opt = e.params.filter((p) => !p.required).map((p) => p.name);
        console.log(`  ${e.key.padEnd(24)} ${e.label}  [${[...req, ...opt].join(" ") || "无参数"}]`);
      }
    }
    console.log("\n用法：npm run af -- <端点key> [参数=值 …]（* 为必填）");
    return;
  }
  if (!afConfigured()) {
    console.error("✗ API_FOOTBALL_KEY 未配置（/srv/playtop.env 或 shell env）");
    process.exit(1);
  }
  const params: Record<string, string> = {};
  for (const arg of rest) {
    const i = arg.indexOf("=");
    if (i > 0) params[arg.slice(0, i)] = arg.slice(i + 1);
  }

  if (key === "selftest") {
    console.log("AF 真机自检中（按套餐限流，预计 1-2 分钟）…\n");
    const rep = await runSelftest({
      league: params.league,
      season: params.season,
      delayMs: params.delay ? Number(params.delay) : undefined,
    });
    console.log(formatSelftest(rep));
    if (rep.summary.error > 0) process.exitCode = 2; // 有报错给非零退出码，便于 CI/脚本判断
    return;
  }

  const r = await runAfEndpoint(key, params);
  console.log(`GET ${r.path}`);
  console.log(`${r.ok ? "✓ OK" : "✗ ERRORS"} · 结果数 ${r.results} · 分页 ${r.paging.current}/${r.paging.total}`);
  if (!r.ok) console.log("errors:", JSON.stringify(r.errors, null, 2));
  console.log(JSON.stringify(r.response, null, 2));
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
