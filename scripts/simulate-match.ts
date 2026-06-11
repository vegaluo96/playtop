/**
 * 端到端全生命周期模拟（无需任何外部网络/真实 LLM）：
 * 建赛 → 录盘口 → 采集 → 建模 → 发布 → 三态校验 → 解锁扣分 →
 * 实时改版 → 时间推进到开赛（锁定终版+predictions）→ 录赛果 → 结算公开 → 战绩/哈希校验。
 *
 * 运行：npm run simulate
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const SIM_DB = path.join(process.cwd(), "data", "simulate.db");
fs.rmSync(SIM_DB, { force: true });
fs.rmSync(`${SIM_DB}-wal`, { force: true });
fs.rmSync(`${SIM_DB}-shm`, { force: true });
process.env.DATABASE_PATH = SIM_DB;
process.env.LLM = "mock";

const T0 = Date.UTC(2026, 5, 10, 10, 0, 0);
process.env.FAKE_NOW = String(T0);

async function main() {
  const { runMigrations } = await import("../src/server/db/migrate");
  runMigrations();
  const { db } = await import("../src/server/db");
  const { users, historyMatches, matches, predictions, analyses } = await import("../src/server/db/schema");
  const { eq } = await import("drizzle-orm");
  const { hashPassword } = await import("../src/server/auth/password");
  const { now } = await import("../src/server/lib/time");
  const { ensureLeague, resolveTeam } = await import("../src/server/services/teamResolver");
  const { createManualMatch } = await import("../src/server/services/matchesService");
  const { insertSnapshot } = await import("../src/server/services/snapshots");
  const { collectMatch } = await import("../src/server/services/collect");
  const { analyzeMatch } = await import("../src/server/services/analyze");
  const { publishAnalysisRow, verifyAnalysis } = await import("../src/server/services/publish");
  const { adminAdjustPoints } = await import("../src/server/services/points");
  const { unlockMatch } = await import("../src/server/services/unlock");
  const { getMatchDetail } = await import("../src/server/services/views");
  const { tickStateMachine } = await import("../src/server/jobs/scheduler");
  const { recordOutcome } = await import("../src/server/services/settle");
  const { recordOverview, recordList } = await import("../src/server/services/stats");
  const { backfillElo } = await import("../src/server/services/eloService");

  const step = (msg: string) => console.log(`\n■ ${msg}`);

  step("0. 准备账号与确定性历史样本（8 队 × 双循环 × 4 轮 = 224 场）");
  // 模拟覆盖付费链路（锁定态/解锁/退款），显式关闭免费公测
  const { setConfig } = await import("../src/server/lib/config");
  setConfig("pricing", { freeBeta: false });
  const adminId = db
    .insert(users)
    .values({ username: "admin", passwordHash: await hashPassword("admin123456"), role: "admin", points: 0, createdAt: now() })
    .returning({ id: users.id })
    .get().id;
  const userId = db
    .insert(users)
    .values({ username: "punter", passwordHash: await hashPassword("password1"), role: "user", points: 0, createdAt: now() })
    .returning({ id: users.id })
    .get().id;

  const leagueId = ensureLeague("INT");
  const names = ["Argentina", "France", "Brazil", "Germany", "Spain", "England", "Portugal", "Netherlands"];
  const teamIds = names.map((n) => resolveTeam(n, "国际"));
  // 确定性"伪随机"比分：强度递减的队伍 + 固定公式（引擎只要可拟合的合理数据）
  let k = 0;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i === j) continue;
        const att = (idx: number) => 1.6 - idx * 0.12;
        const hg = Math.max(0, Math.round(att(i) - 0.55 * att(j) + ((k * 7) % 5) * 0.35 - 0.3));
        const ag = Math.max(0, Math.round(att(j) * 0.8 - 0.5 * att(i) + ((k * 11) % 4) * 0.3 - 0.2));
        db.insert(historyMatches)
          .values({
            leagueId,
            season: "2025",
            playedAt: T0 - (250 - k) * 86_400_000,
            homeTeamId: teamIds[i],
            awayTeamId: teamIds[j],
            homeGoals: Math.min(hg, 5),
            awayGoals: Math.min(ag, 5),
            neutral: 1,
            dedupKey: `sim|${k}`,
            createdAt: now(),
          })
          .run();
        k++;
      }
    }
  }
  console.log(`  历史样本 ${k} 场，Elo 回放 ${backfillElo()} 场`);

  step("1. 建赛（世界杯风格：中立场，开球 T0+2h）");
  const kickoffAt = T0 + 2 * 3_600_000;
  const matchId = createManualMatch({
    leagueCode: "INT",
    country: "国际",
    homeName: "Argentina",
    awayName: "France",
    kickoffAt,
    venue: "MetLife Stadium",
    neutral: true,
    round: "决赛重演",
  });

  step("2. 手动录入盘口 + 软信息（免外网路径）→ 采集 → ready");
  insertSnapshot(matchId, "odds", "manual", {
    bookmaker: "模拟盘口",
    oneXTwo: { home: 2.05, draw: 3.3, away: 3.8 },
    ou: [{ line: 2.5, over: 2.0, under: 1.85 }],
    ah: [{ line: -0.25, home: 1.95, away: 1.95 }],
    capturedAt: now(),
  });
  insertSnapshot(matchId, "soft_info", "manual", {
    items: [{ topic: "动机", content: "决赛重演，双方均全主力出战。", sourceHint: "模拟" }],
  });
  const collected = await collectMatch(matchId, { skipAi: true });
  console.log(`  采集完成：成功 ${collected.collected.join("/")}；失败（预期内，离线维度）${collected.failed.map((f) => f.kind).join("/") || "无"}`);
  assert.equal(collected.status, "ready", "数据齐备后应进入 ready");

  step("3. 建模 → 草稿 → 发布（定价 20 分）");
  const a1 = await analyzeMatch(matchId);
  assert.equal(a1.version, 1);
  publishAnalysisRow(a1.analysisId, { adminId, pricePoints: 20 });
  const pubView = getMatchDetail(matchId, null);
  assert(pubView, "发布后应可见");
  assert.equal(pubView!.access, "locked", "匿名访客应为锁定态");
  assert.equal(pubView!.engine, null, "锁定态不得泄露引擎数据");
  assert(pubView!.snapshots.total >= 5, "锁定态应展示数据完备度");

  step("4. 解锁流程：余额不足拒绝 → 充值 → 解锁 → 幂等");
  let threw = false;
  try {
    unlockMatch(userId, matchId);
  } catch {
    threw = true;
  }
  assert(threw, "余额不足必须拒绝");
  adminAdjustPoints({ adminId, userId, delta: 100, note: "模拟充值" });
  const u1 = unlockMatch(userId, matchId);
  assert.equal(u1.pointsSpent, 20);
  assert.equal(u1.balanceAfter, 80);
  assert.equal(unlockMatch(userId, matchId).alreadyUnlocked, true, "重复解锁必须幂等");
  const unlockedView = getMatchDetail(matchId, userId);
  assert.equal(unlockedView!.access, "unlocked");
  assert(unlockedView!.engine, "解锁后应可见全部引擎数据");
  assert(unlockedView!.engine!.picks.length >= 0);

  step("5. 实时改版：盘口变动 → 重算 → 新版本自动发布");
  process.env.FAKE_NOW = String(T0 + 30 * 60_000);
  insertSnapshot(matchId, "odds", "manual", {
    bookmaker: "模拟盘口",
    oneXTwo: { home: 1.92, draw: 3.4, away: 4.1 }, // 主队降赔
    ou: [{ line: 2.5, over: 2.0, under: 1.85 }],
    ah: [{ line: -0.5, home: 2.0, away: 1.9 }],
    capturedAt: now(),
  });
  const a2 = await analyzeMatch(matchId, { autoPublishRevision: true });
  assert.equal(a2.changed, true);
  assert.equal(a2.version, 2);
  assert.equal(a2.autoPublished, true, "已发布比赛的新版本应自动发布");
  const v2 = getMatchDetail(matchId, userId)!;
  assert.equal(v2.card.version, 2);
  assert.equal(v2.versions.length, 2, "版本演化应有两版");
  assert(v2.engine!.oddsMovement.length >= 2, "盘口异动序列应≥2");

  step("6. 时间推进到开赛 → 状态机锁定终版与 predictions → in_play");
  process.env.FAKE_NOW = String(kickoffAt + 60_000);
  const tick1 = await tickStateMachine();
  assert.equal(tick1.locked, 1, "应锁定 1 场");
  const lockedMatch = db.select().from(matches).where(eq(matches.id, matchId)).get()!;
  assert.equal(lockedMatch.status, "in_play");
  assert(lockedMatch.finalAnalysisId, "终版应被记录");
  const preds = db.select().from(predictions).where(eq(predictions.matchId, matchId)).all();
  console.log(`  终版 picks 落库 ${preds.length} 条（含锁定赔率与收盘赔率）`);

  step("7. 录入赛果 2:1 → 结算 → 全部报告免费公开");
  process.env.FAKE_NOW = String(kickoffAt + 2 * 3_600_000);
  recordOutcome({ matchId, homeGoals: 2, awayGoals: 1, source: "manual", provisional: false, recordedBy: adminId });
  const tick2 = await tickStateMachine();
  assert.equal(tick2.settled, 1, "应结算 1 场");
  const settled = db.select().from(matches).where(eq(matches.id, matchId)).get()!;
  assert.equal(settled.status, "settled");
  const anonView = getMatchDetail(matchId, null)!;
  assert.equal(anonView.access, "public", "赛后匿名访客应免费可读全文");
  assert(anonView.engine, "公开态应有完整引擎数据");
  const settledPreds = db.select().from(predictions).where(eq(predictions.matchId, matchId)).all();
  for (const p of settledPreds) {
    assert(["hit", "miss", "push"].includes(p.result), `预测应已判定（实际 ${p.result}）`);
  }

  step("8. 战绩与诚信：统计聚合 + 哈希链校验 + 篡改检测");
  const overview = recordOverview(null);
  const totalGraded = overview.reduce((s, m) => s + m.hits + m.misses + m.pushes, 0);
  assert.equal(totalGraded, settledPreds.length, "战绩分母 = 已判定预测数");
  assert(recordList(10).length === settledPreds.length);
  const allAnalyses = db.select().from(analyses).where(eq(analyses.matchId, matchId)).all();
  for (const a of allAnalyses) {
    assert.equal(a.status, "public", "结算后所有已发布版本应转 public");
    const v = verifyAnalysis(a.id);
    assert(v.valid, `版本 V${a.version} 哈希校验应通过：${v.detail}`);
  }
  // 篡改检测
  const tamper = allAnalyses[0];
  db.update(analyses).set({ reportMd: tamper.reportMd + " " }).where(eq(analyses.id, tamper.id)).run();
  assert.equal(verifyAnalysis(tamper.id).valid, false, "篡改必须被检出");
  db.update(analyses).set({ reportMd: tamper.reportMd }).where(eq(analyses.id, tamper.id)).run();

  console.log("\n✅ 端到端模拟全部通过：建赛→采集→建模→发布→解锁→实时改版→锁定→结算→公开→战绩→防篡改");
}

main().catch((e) => {
  console.error("\n❌ 模拟失败：", e);
  process.exit(1);
});
