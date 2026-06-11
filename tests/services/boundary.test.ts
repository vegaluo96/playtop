import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { auditLogs, predictions } from "@/server/db/schema";
import { minAcceptableOdds } from "@/server/engine/boundary";
import { setConfig } from "@/server/lib/config";
import { analyzeMatch, latestAnalysis } from "@/server/services/analyze";
import { createManualMatch, transitionMatch } from "@/server/services/matchesService";
import { publishAnalysisRow } from "@/server/services/publish";
import { lockFinalAnalysisAtKickoff } from "@/server/services/settle";
import { insertSnapshot } from "@/server/services/snapshots";

const T0 = Date.UTC(2026, 5, 11, 12, 0);

beforeAll(() => {
  process.env.FAKE_NOW = String(T0);
  runMigrations();
  // 无历史库环境：模型≈市场，EV 全负——放开阈值强制产出观点；边界垫用缺省 1.02
  setConfig("engine", { evThreshold: -1, minProbForPick: 0 });
});

afterAll(() => {
  delete process.env.FAKE_NOW;
});

describe("最低可接受赔率（边界线）", () => {
  it("margin/概率，保留两位小数；非法输入返回 0（边界关闭）", () => {
    expect(minAcceptableOdds(0.5, 1.02)).toBe(2.04);
    expect(minAcceptableOdds(0.25, 1.02)).toBe(4.08);
    expect(minAcceptableOdds(0, 1.02)).toBe(0);
    expect(minAcceptableOdds(0.5, 0)).toBe(0);
    expect(minAcceptableOdds(-1, 1.02)).toBe(0);
  });
});

describe("锁定问责：收盘价低于边界的观点按观望处理", () => {
  function makePublished(home: string, away: string, kickoffAt: number): number {
    const id = createManualMatch({ leagueCode: "WC2026", homeName: home, awayName: away, kickoffAt, neutral: true });
    insertSnapshot(id, "odds", "manual", {
      bookmaker: "bet365",
      oneXTwo: { home: 2.0, draw: 3.4, away: 4.0 },
      ou: [],
      ah: [],
      capturedAt: T0,
    });
    transitionMatch(id, "collecting");
    transitionMatch(id, "ready");
    return id;
  }

  it("负 EV 观点的收盘价必然低于边界 → 不落 predictions + 审计留痕", async () => {
    const id = makePublished("Mexico", "Korea Republic", T0 + 2 * 3_600_000);
    await analyzeMatch(id);
    publishAnalysisRow(latestAnalysis(id)!.id, {});
    process.env.FAKE_NOW = String(T0 + 2 * 3_600_000 + 60_000);
    expect(lockFinalAnalysisAtKickoff()).toBe(1);
    expect(db.select().from(predictions).where(eq(predictions.matchId, id)).all()).toHaveLength(0);
    const logs = db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "lock_invalidated_pick"), eq(auditLogs.entityId, id)))
      .all();
    expect(logs.length).toBeGreaterThan(0);
    const detail = JSON.parse(logs[0].detail!) as { closingOdds: number; minAcceptable: number };
    expect(detail.closingOdds).toBeLessThan(detail.minAcceptable);
    process.env.FAKE_NOW = String(T0);
  });

  it("收盘价仍高于边界的观点照常落 predictions（收盘升赔场景）", async () => {
    const id = makePublished("Canada", "Ecuador", T0 + 3 * 3_600_000);
    await analyzeMatch(id);
    publishAnalysisRow(latestAnalysis(id)!.id, {});
    // 收盘大幅升赔：所有点位的收盘价都高于各自边界线
    insertSnapshot(id, "odds", "manual", {
      bookmaker: "bet365",
      oneXTwo: { home: 8.0, draw: 8.0, away: 8.0 },
      ou: [],
      ah: [],
      capturedAt: T0 + 60_000,
    });
    process.env.FAKE_NOW = String(T0 + 3 * 3_600_000 + 60_000);
    expect(lockFinalAnalysisAtKickoff()).toBe(1);
    const preds = db.select().from(predictions).where(eq(predictions.matchId, id)).all();
    expect(preds.length).toBeGreaterThan(0);
    for (const p of preds) expect(p.closingOdds).toBe(8);
    process.env.FAKE_NOW = String(T0);
  });
});
