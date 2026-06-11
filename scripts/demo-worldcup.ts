/**
 * 世界杯端到端闭环 demo（真实数据驱动）：
 * 真实赛程(openfootball) + 真实国际赛历史(martj42) + 真实射手数据集 →
 * 自动建赛 → 用户端可见 → 采集（网络受限源失败自动记健康账本）→ 多书商盘口
 * （沙箱注入同一写入口径；生产由适配器自动抓取）→ 自动建模（真实历史 DC 拟合 +
 * 加权共识）→ 自动发布 → 开赛锁定 → 权威赛果 → 自动结算公开 → 战绩 + 哈希校验。
 *
 * 运行：npm run demo:wc（需可访问 GitHub raw）
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const DB = path.join(process.cwd(), "data", "demo-wc.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
process.env.DATABASE_PATH = DB;
process.env.LLM = "mock";

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0); // 揭幕战前一天
process.env.FAKE_NOW = String(T0);
const step = (n: number, title: string) => console.log(`\n■ ${n}. ${title}`);

async function main() {
  const { runMigrations } = await import("../src/server/db/migrate");
  runMigrations();
  const { bootstrapOnFirstRun } = await import("../src/server/db/bootstrap");
  await bootstrapOnFirstRun();
  const { db } = await import("../src/server/db");
  const { matches, analyses, predictions } = await import("../src/server/db/schema");
  const { asc, eq } = await import("drizzle-orm");
  const { importInternationalHistory } = await import("../src/server/services/importHistory");
  const { backfillElo } = await import("../src/server/services/eloService");
  const { importWorldCupFixtures } = await import("../src/server/services/importWorldCup");
  const { listMatchCards, getUpcomingFixture, getMatchDetail } = await import("../src/server/services/views");
  const { collectMatch } = await import("../src/server/services/collect");
  const { insertSnapshot, latestOddsBookRows } = await import("../src/server/services/snapshots");
  const { advanceMatch } = await import("../src/server/services/automation");
  const { tickStateMachine } = await import("../src/server/jobs/scheduler");
  const { recordOutcome } = await import("../src/server/services/settle");
  const { verifyAnalysis } = await import("../src/server/services/publish");
  const { recordList } = await import("../src/server/services/stats");
  const { listSourceHealth } = await import("../src/server/services/sourceHealth");
  const { teamNameById } = await import("../src/server/services/teamResolver");
  const { engineOutputSchema } = await import("../src/server/engine/types");

  const { setConfig } = await import("../src/server/lib/config");
  setConfig("pricing", { freeBeta: false }); // 演示付费链路
  step(1, "真实历史底座：martj42 国际赛 2022 起 + Elo 全量回放");
  const hist = await importInternationalHistory(2022, true);
  console.log(`  导入历史 ${hist.inserted} 场`);
  assert(hist.inserted > 1500, "历史导入量异常");
  console.log(`  Elo 回放 ${backfillElo()} 场`);

  step(2, "真实世界杯赛程自动建赛（openfootball）");
  const wc = await importWorldCupFixtures(true);
  console.log(`  建赛 ${wc.created} 场（淘汰赛待定 ${wc.pendingKnockout}）`);
  assert(wc.created >= 70, "世界杯建赛数量异常");
  const opener = db.select().from(matches).orderBy(asc(matches.kickoffAt)).limit(1).get()!;
  const home = teamNameById(opener.homeTeamId);
  const away = teamNameById(opener.awayTeamId);
  console.log(`  揭幕战：${home} vs ${away} @ ${new Date(opener.kickoffAt).toISOString()}（${opener.venue}）`);

  step(3, "用户端冷启动可见性");
  const cards = listMatchCards(null);
  console.log(`  首页卡片 ${cards.length} 张（未来 14 天）`);
  assert(cards.some((c) => c.id === opener.id && c.status === "scheduled"), "揭幕战应以准备中状态可见");
  assert(getUpcomingFixture(opener.id) !== null, "赛程详情视图应可用");

  step(4, "真实采集（网络受限源 → 健康账本自动记账）");
  const summary = await collectMatch(opener.id, {});
  console.log(`  成功维度：${summary.collected.join("、") || "（无）"}`);
  console.log(`  失败维度：${summary.failed.map((f) => f.kind).join("、") || "（无）"}`);
  assert(summary.collected.includes("h2h") && summary.collected.includes("form"), "本地历史统计应成功");
  assert(summary.collected.includes("player_stats"), "真实射手数据集应成功（GitHub 可达）");

  step(5, "多书商盘口注入（与适配器同一写入口径；生产环境自动抓取）");
  const cap = Number(process.env.FAKE_NOW);
  const books: [string, object][] = [
    ["smarkets", { bookmaker: "Smarkets（交易所）", oneXTwo: { home: 1.62, draw: 4.0, away: 6.2 }, ou: [], ah: [], capturedAt: cap }],
    ["manual", { bookmaker: "bet365", oneXTwo: { home: 1.6, draw: 3.9, away: 6.0 }, ou: [{ line: 2.5, over: 2.05, under: 1.78 }], ah: [{ line: -1, home: 2.02, away: 1.84 }], capturedAt: cap }],
    ["sporttery", { bookmaker: "中国竞彩（官方）", oneXTwo: { home: 1.58, draw: 3.75, away: 5.5 }, ou: [], ah: [], hhad: { line: -1, home: 2.5, draw: 3.3, away: 2.4 }, totalGoals: { "0": 8.5, "1": 4.4, "2": 3.5, "3": 4.3, "4": 7, "5": 13, "6": 25, "7+": 40 }, correctScores: [{ score: "1:0", odds: 6.2 }, { score: "2:0", odds: 8.0 }, { score: "2:1", odds: 9.0 }, { score: "1:1", odds: 6.8 }, { score: "0:0", odds: 9.5 }, { score: "0:1", odds: 13 }, { score: "3:0", odds: 14 }, { score: "3:1", odds: 16 }], capturedAt: cap }],
    ["polymarket", { bookmaker: "Polymarket", oneXTwo: { home: 1.64, draw: 4.1, away: 6.4 }, ou: [], ah: [], capturedAt: cap }],
    ["manifold", { bookmaker: "Manifold（模拟盘）", oneXTwo: { home: 1.9, draw: 4.2, away: 5.0 }, ou: [], ah: [], indicative: true, capturedAt: cap }],
  ];
  for (const [src, payload] of books) insertSnapshot(opener.id, "odds", src as never, payload);
  console.log(`  并存书商：${latestOddsBookRows(opener.id).map((b) => b.bookmaker).join("、")}`);
  assert(latestOddsBookRows(opener.id).length >= 5, "多书商应并存");

  step(6, "全自动推进：建模（真实历史 DC 拟合 + 加权共识）→ 默认价发布");
  await collectMatch(opener.id, { skipAi: true }); // 盘口已到位 → ready
  const steps = await advanceMatch(opener.id);
  for (const s of steps) console.log(`  ${s}`);
  const published = db.select().from(matches).where(eq(matches.id, opener.id)).get()!;
  assert(published.status === "published", `应自动发布，实际 ${published.status}`);
  const analysis = db.select().from(analyses).where(eq(analyses.matchId, opener.id)).get()!;
  const engine = engineOutputSchema.parse(JSON.parse(analysis.engineOutput));
  console.log(`  退化等级 L${engine.fallbackLevel}；集成概率 主${(engine.ensemble.probs.home * 100).toFixed(1)}%`);
  assert(engine.fallbackLevel <= 2, "真实历史下 DC 应达 MLE/矩估计档（历史池共享修复验证）");
  assert(engine.market!.books.length >= 5, "市场成员应含全部书商");
  const wTrace = engine.trace.find((t) => t.includes("加权共识"));
  console.log(`  ${wTrace}`);
  assert(wTrace?.includes("Manifold（模拟盘）×0.30"), "模拟盘应以 0.3 权重进共识");
  assert(engine.scoreMarket.length > 0, "波胆对照应生成");
  for (const p of engine.picks) {
    console.log(`  pick：${p.market}/${p.selection} @${p.odds}（${p.bookmaker}，EV ${(p.ev! * 100).toFixed(1)}%）`);
    assert(p.bookmaker !== "Manifold（模拟盘）", "picks 不得出自模拟盘");
  }

  step(7, "用户端发布态：锁定预览 + 定价");
  const detail = getMatchDetail(opener.id, null)!;
  assert(detail.access === "locked" && (detail.card.pricePoints ?? 0) > 0, "未登录应为锁定态且有价");
  console.log(`  解锁价 ${detail.card.pricePoints} 分；状态 ${detail.card.status}`);

  step(8, "时间推进 → 开赛自动锁定终版与 predictions");
  process.env.FAKE_NOW = String(opener.kickoffAt + 60_000);
  const lockRes = await tickStateMachine();
  console.log(`  锁定 ${lockRes.locked} 场`);
  const preds = db.select().from(predictions).where(eq(predictions.matchId, opener.id)).all();
  console.log(`  predictions 落库 ${preds.length} 条（含锁定与收盘赔率）`);
  assert(preds.length > 0 && preds.every((p) => p.closingOdds !== null), "收盘赔率应按书商口径取到");

  step(9, "权威赛果（生产由 fetchResultsFromApiFootball 自动抓取）→ 自动结算公开");
  process.env.FAKE_NOW = String(opener.kickoffAt + 2.5 * 3_600_000);
  recordOutcome({ matchId: opener.id, homeGoals: 2, awayGoals: 1, source: "api_football", provisional: false });
  const settleRes = await tickStateMachine();
  console.log(`  结算 ${settleRes.settled} 场`);
  const final = db.select().from(matches).where(eq(matches.id, opener.id)).get()!;
  assert(final.status === "settled", `应已结算，实际 ${final.status}`);
  const pub = getMatchDetail(opener.id, null)!;
  assert(pub.access === "public", "赛后应免费公开");

  step(10, "战绩与诚信闭环");
  const rows = recordList(10);
  console.log(`  战绩流水 ${rows.length} 条；首条 ${rows[0]?.market}/${rows[0]?.selection} → ${rows[0]?.result}`);
  assert(rows.length > 0, "战绩应有已结算观点");
  assert(verifyAnalysis(final.finalAnalysisId!), "终版哈希校验应通过");

  step(11, "数据源健康账本（沙箱网络仅放行 GitHub，失败源即自动降级的演示）");
  for (const h of listSourceHealth()) {
    console.log(
      `  ${h.consecutiveFails > 0 ? "✗" : "✓"} ${h.source}：成 ${h.okCount} / 败 ${h.failCount}` +
        `${h.consecutiveFails > 0 ? `（连败 ${h.consecutiveFails}${h.lastError ? `：${h.lastError.slice(0, 60)}` : ""}）` : ""}`,
    );
  }

  console.log(
    "\n✅ 世界杯闭环全部走通：真实赛程建赛→用户可见→采集→多书商加权共识建模→自动发布→锁定→权威赛果→结算公开→战绩哈希校验；网络受限源全部软降级并记账。",
  );
}

main().catch((e) => {
  console.error("\n✗ demo 失败：", e);
  process.exit(1);
});

export {};
