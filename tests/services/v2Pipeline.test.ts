import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import {
  auditHashes,
  matchSnapshots,
  matches,
  modelRuns,
  oddsSnapshots,
  reportLocks,
  reportVersions,
  settlements,
  trackRecords,
  rawApiPayloads,
} from "@/server/db/schema";
import { analyzeMatch } from "@/server/services/analyze";
import { createManualMatch, transitionMatch } from "@/server/services/matchesService";
import { publishAnalysisRow } from "@/server/services/publish";
import { lockFinalAnalysisAtKickoff, recordOutcome, settleDueMatches } from "@/server/services/settle";
import { insertSnapshot } from "@/server/services/snapshots";
import { seedProviders, providerForUrl, recordRawPayload } from "@/server/v2/providers";
import { settleAhDetailed } from "@/server/v2/pipeline";
import { appendAuditHash, verifyAuditChain } from "@/server/v2/audit";

const T0 = Date.UTC(2026, 5, 10, 12, 0);
let matchId: number;

beforeAll(async () => {
  process.env.FAKE_NOW = String(T0);
  runMigrations();
  seedProviders();
  // 测试无历史库 → 模型≈市场 → EV 全为负水位。放开阈值强制产出观点（确定性），
  // 以便验证结算/ROI/Brier 全链路。
  const { setConfig } = await import("@/server/lib/config");
  setConfig("engine", { evThreshold: -1, minProbForPick: 0 });
});

afterAll(() => {
  delete process.env.FAKE_NOW;
});

describe("V2 流水线：analyze 钩子产出完整对象链", () => {
  it("建模一次 → 快照归并 + 盘口扁平化 + ModelRun + ReportVersion 全部落库", async () => {
    matchId = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Mexico",
      awayName: "South Africa",
      kickoffAt: T0 + 5 * 3_600_000,
      neutral: false,
    });
    insertSnapshot(matchId, "odds", "manual", {
      bookmaker: "bet365",
      oneXTwo: { home: 1.6, draw: 3.9, away: 6.0 },
      ou: [{ line: 2.5, over: 2.0, under: 1.82 }],
      ah: [{ line: -1, home: 2.05, away: 1.8 }],
      capturedAt: T0,
    });
    insertSnapshot(matchId, "odds", "smarkets", {
      bookmaker: "Smarkets（交易所）",
      oneXTwo: { home: 1.63, draw: 4.0, away: 6.2 },
      ou: [],
      ah: [],
      capturedAt: T0,
    });
    transitionMatch(matchId, "collecting");
    transitionMatch(matchId, "ready");

    const r = await analyzeMatch(matchId);
    expect(r.changed).toBe(true);

    const snap = db.select().from(matchSnapshots).where(eq(matchSnapshots.matchId, matchId)).all();
    expect(snap).toHaveLength(1);
    expect(snap[0].snapshotType).toBe("T6"); // 距开球 5h → T6 档
    expect(snap[0].snapshotHash).toBeTruthy();

    const flat = db.select().from(oddsSnapshots).where(eq(oddsSnapshots.matchId, matchId)).all();
    // bet365: 1X2×3 + OU×2 + AH×2 = 7；Smarkets: 1X2×3 = 3
    expect(flat).toHaveLength(10);
    const home1x2 = flat.find((x) => x.bookmakerName === "bet365" && x.marketType === "one_x_two" && x.selection === "home")!;
    expect(home1x2.impliedProbability).toBeCloseTo(1 / 1.6, 6);
    expect(home1x2.normalizedProbability!).toBeLessThan(home1x2.impliedProbability); // 去水后 < 含水

    const run = db.select().from(modelRuns).where(eq(modelRuns.matchId, matchId)).get()!;
    expect(run.status).toBe("success");
    expect(run.modelVersion).toBe("engine-1.1.0");
    expect(JSON.parse(run.inputJson).books).toHaveLength(2); // 输入完整持久化，可重放
    expect(run.inputHash).toBeTruthy();

    const rv = db.select().from(reportVersions).where(eq(reportVersions.matchId, matchId)).get()!;
    expect(rv.modelRunId).toBe(run.id);
    expect(rv.isPublic).toBe(0); // 赛前不公开
    expect(JSON.parse(rv.freePreview).ensemble.home).toBeGreaterThan(0);
    expect(rv.paidContent).toContain("摘要");
    expect(JSON.parse(rv.numbersWhitelistJson!).length).toBeGreaterThan(0);
  });

  it("重复建模（输入未变）不产生重复对象", async () => {
    const r2 = await analyzeMatch(matchId);
    expect(r2.changed).toBe(false);
    expect(db.select().from(modelRuns).where(eq(modelRuns.matchId, matchId)).all()).toHaveLength(1);
  });

  it("开赛锁定 → report_locks 终版三元组（幂等）", async () => {
    const { latestAnalysis } = await import("@/server/services/analyze");
    publishAnalysisRow(latestAnalysis(matchId)!.id, {});
    process.env.FAKE_NOW = String(T0 + 5 * 3_600_000 + 60_000); // 开球后 1 分钟
    expect(lockFinalAnalysisAtKickoff()).toBe(1);
    const lock = db.select().from(reportLocks).where(eq(reportLocks.matchId, matchId)).get()!;
    expect(lock.finalModelRunId).not.toBeNull();
    expect(lock.lockHash).toBeTruthy();
    expect(lockFinalAnalysisAtKickoff()).toBe(0); // 幂等：不重复锁定
  });

  it("赛后结算 → settlements（ROI/Brier）+ is_public 翻转 + track_records 物化", async () => {
    recordOutcome({ matchId, homeGoals: 2, awayGoals: 0, source: "espn", provisional: false });
    expect(settleDueMatches()).toBe(1);
    const stl = db.select().from(settlements).where(eq(settlements.matchId, matchId)).all();
    expect(stl.length).toBeGreaterThan(0);
    for (const s of stl) {
      expect(s.brierScore).toBeGreaterThan(0);
      expect(s.brierScore!).toBeLessThan(2);
      expect(s.settlementHash).toBeTruthy();
    }
    // ROI 与结算结果符号一致（win→正、lose→-1、push→0、half_*→±0.5 区间）
    for (const s of stl) {
      if (s.roi === null) continue;
      if (s.settlementResult === "win" || s.settlementResult === "half_win") expect(s.roi).toBeGreaterThan(0);
      if (s.settlementResult === "lose") expect(s.roi).toBe(-1);
      if (s.settlementResult === "half_lose") expect(s.roi).toBe(-0.5);
      if (s.settlementResult === "push" || s.settlementResult === "void") expect(s.roi).toBe(0);
    }
    expect(db.select().from(reportVersions).where(eq(reportVersions.matchId, matchId)).get()!.isPublic).toBe(1);
    const global = db.select().from(trackRecords).where(eq(trackRecords.scopeType, "global")).get()!;
    expect(global.publishedOpinions).toBe(stl.length);
    expect(global.totalMatches).toBe(1);
  });

  it("审计链完整且可检测篡改", () => {
    for (const t of ["model_run", "report_version", "report_lock", "settlement"]) {
      expect(verifyAuditChain(t).ok).toBe(true);
    }
    // 篡改一节 → 断链
    appendAuditHash("tamper_demo", 1, { a: 1 });
    appendAuditHash("tamper_demo", 2, { a: 2 });
    db.update(auditHashes).set({ previousHash: "forged" }).where(eq(auditHashes.entityType, "tamper_demo")).run();
    expect(verifyAuditChain("tamper_demo").ok).toBe(false);
  });
});

describe("V2 结算细则与原始留档", () => {
  it("亚盘四态：quarter 线半赢半输", () => {
    // 主让 -0.75，主队净胜 1 球 → adj = 1 - 0.75 = 0.25 → half_win
    expect(settleAhDetailed(1, -0.75, "home")).toBe("half_win");
    expect(settleAhDetailed(1, -1.25, "home")).toBe("half_lose");
    expect(settleAhDetailed(1, -1, "home")).toBe("push");
    expect(settleAhDetailed(2, -1, "home")).toBe("win");
    expect(settleAhDetailed(0, -0.5, "away")).toBe("win");
  });

  it("原始响应留档：URL→provider 归属 + 大正文截断", () => {
    expect(providerForUrl("https://site.api.espn.com/apis/x")).toBe("espn");
    expect(providerForUrl("https://webapi.sporttery.cn/x")).toBe("sporttery");
    expect(providerForUrl("https://unknown.example.com")).toBeNull();
    recordRawPayload({ endpoint: "https://api.clubelo.com/2026-06-10", httpStatus: 200, body: "x".repeat(600 * 1024) });
    const row = db.select().from(rawApiPayloads).orderBy(desc(rawApiPayloads.id)).limit(1).get()!;
    expect(row.responseJson).toContain("[truncated");
    expect(row.responseHash).toBeTruthy();
    recordRawPayload({ endpoint: "https://api.clubelo.com/err", httpStatus: 403, body: null, errorMessage: "HTTP 403" });
    const err = db.select().from(rawApiPayloads).orderBy(desc(rawApiPayloads.id)).limit(1).get()!;
    expect(err.errorMessage).toBe("HTTP 403");
  });
});
