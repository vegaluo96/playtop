import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { analyses, auditLogs, matches, outcomes } from "@/server/db/schema";
import { setConfig } from "@/server/lib/config";
import { advanceMatch } from "@/server/services/automation";
import { createManualMatch, transitionMatch } from "@/server/services/matchesService";
import { autoConfirmDueOutcomes, confirmOutcomeRow, recordOutcome } from "@/server/services/settle";
import { insertSnapshot } from "@/server/services/snapshots";

const T0 = Date.UTC(2026, 5, 10, 12, 0);

function matchStatus(id: number): string {
  return db.select().from(matches).where(eq(matches.id, id)).get()!.status;
}

beforeAll(() => {
  process.env.FAKE_NOW = String(T0);
  runMigrations();
});

afterAll(() => {
  delete process.env.FAKE_NOW;
});

describe("advanceMatch：ready → 建模 → 发布全链路", () => {
  it("自动化全开时一次推进到 published（默认价），审计 actor=0", async () => {
    const id = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Spain",
      awayName: "Uruguay",
      kickoffAt: T0 + 6 * 3_600_000,
      neutral: true,
    });
    insertSnapshot(id, "odds", "manual", {
      bookmaker: "bet365",
      oneXTwo: { home: 1.8, draw: 3.6, away: 4.6 },
      ou: [{ line: 2.5, over: 1.9, under: 1.9 }],
      ah: [],
      capturedAt: T0,
    });
    transitionMatch(id, "collecting");
    transitionMatch(id, "ready");

    const steps = await advanceMatch(id);
    expect(steps.length).toBeGreaterThanOrEqual(2); // 建模 + 发布
    expect(matchStatus(id)).toBe("published");

    const a = db.select().from(analyses).where(eq(analyses.matchId, id)).orderBy(desc(analyses.version)).get()!;
    expect(a.status).toBe("published");
    const audit = db.select().from(auditLogs).where(eq(auditLogs.action, "auto_publish")).all();
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].actorId).toBe(0);
  });

  it("无盘口卡在采集中时：手动建模/发布沿状态机快进（修复'collecting 不可发布'）", async () => {
    const { analyzeMatch } = await import("@/server/services/analyze");
    const { publishAnalysisRow } = await import("@/server/services/publish");
    const id = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Portugal",
      awayName: "Colombia",
      kickoffAt: T0 + 6 * 3_600_000,
      neutral: true,
    });
    transitionMatch(id, "collecting"); // 无盘口 → 停在采集中
    const r = await analyzeMatch(id); // 手动运行引擎（不再要求 ready）
    expect(matchStatus(id)).toBe("analyzed"); // 快进 collecting→ready→analyzed
    publishAnalysisRow(r.analysisId, {}); // 手动发布不再报"collecting 不可发布"
    expect(matchStatus(id)).toBe("published");
  });

  it("autoPublish 关闭时停在已建模等待人工", async () => {
    setConfig("automation", { autoPublish: false });
    const id = createManualMatch({
      leagueCode: "WC2026",
      homeName: "France",
      awayName: "Norway",
      kickoffAt: T0 + 6 * 3_600_000,
      neutral: true,
    });
    insertSnapshot(id, "odds", "manual", {
      bookmaker: "bet365",
      oneXTwo: { home: 1.5, draw: 4.2, away: 6.5 },
      ou: [],
      ah: [],
      capturedAt: T0,
    });
    transitionMatch(id, "collecting");
    transitionMatch(id, "ready");
    await advanceMatch(id);
    expect(matchStatus(id)).toBe("analyzed");
    setConfig("automation", { autoPublish: true }); // 恢复
  });
});

describe("AI 赛果自动确认", () => {
  function makeInPlay(home: string, away: string): number {
    const id = createManualMatch({ leagueCode: "WC2026", homeName: home, awayName: away, kickoffAt: T0 - 4 * 3_600_000, neutral: true });
    transitionMatch(id, "collecting");
    transitionMatch(id, "ready");
    transitionMatch(id, "analyzed");
    transitionMatch(id, "published");
    transitionMatch(id, "in_play");
    return id;
  }

  it("delay 策略：到时自动确认并推进到 finished", () => {
    setConfig("automation", { aiResultConfirmPolicy: "delay", aiResultConfirmDelayHours: 6 });
    const id = makeInPlay("Japan", "Sweden");
    recordOutcome({ matchId: id, homeGoals: 2, awayGoals: 1, source: "llm", provisional: true });
    expect(autoConfirmDueOutcomes()).toBe(0); // 未到时
    process.env.FAKE_NOW = String(T0 + 7 * 3_600_000);
    expect(autoConfirmDueOutcomes()).toBe(1);
    expect(matchStatus(id)).toBe("finished");
    const o = db.select().from(outcomes).where(eq(outcomes.matchId, id)).get()!;
    expect(o.provisional).toBe(0);
    process.env.FAKE_NOW = String(T0);
    setConfig("automation", { aiResultConfirmPolicy: "double_check" });
  });

  it("已确认赛果（含人工）不可被 provisional 覆盖", () => {
    const id = makeInPlay("Ghana", "Panama");
    recordOutcome({ matchId: id, homeGoals: 1, awayGoals: 0, source: "manual", provisional: false, recordedBy: 1 });
    recordOutcome({ matchId: id, homeGoals: 9, awayGoals: 9, source: "llm", provisional: true });
    const o = db.select().from(outcomes).where(eq(outcomes.matchId, id)).get()!;
    expect(o.homeGoals).toBe(1);
    expect(o.provisional).toBe(0);
  });

  it("confirmOutcomeRow 幂等：已确认再次确认不报错", () => {
    const id = makeInPlay("Iraq", "Senegal");
    recordOutcome({ matchId: id, homeGoals: 0, awayGoals: 0, source: "llm", provisional: true });
    confirmOutcomeRow(id, { auto: true });
    expect(() => confirmOutcomeRow(id, { auto: true })).not.toThrow();
    expect(matchStatus(id)).toBe("finished");
  });
});
