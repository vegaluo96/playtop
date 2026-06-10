import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { runMigrations } from "@/server/db/migrate";
import { db } from "@/server/db";
import { analyses, matches, pointTransactions, users } from "@/server/db/schema";
import { adminAdjustPoints } from "@/server/services/points";
import { hasUnlocked, refundMatchUnlocks, unlockMatch } from "@/server/services/unlock";
import { createManualMatch } from "@/server/services/matchesService";
import { computeAnalysisHash, publishAnalysisRow, updateDraftSections, verifyAnalysis } from "@/server/services/publish";
import { HttpError } from "@/server/lib/api";
import { now } from "@/server/lib/time";

let adminId: number;
let userId: number;
let matchId: number;
let analysisId: number;

function insertDraftAnalysis(mid: number, version = 1): number {
  return db
    .insert(analyses)
    .values({
      matchId: mid,
      version,
      modelVersion: "engine-test",
      engineOutput: JSON.stringify({ test: true, version }),
      reportMd: `# 测试报告 v${version}`,
      llmSections: JSON.stringify({ thesis: "测试", drivers: ["a"], risks: ["b"] }),
      inputSnapshotIds: "[]",
      status: "draft",
      createdAt: now(),
      updatedAt: now(),
    })
    .returning({ id: analyses.id })
    .get().id;
}

beforeAll(() => {
  runMigrations();
  adminId = db
    .insert(users)
    .values({ username: "admin", passwordHash: "x", role: "admin", points: 0, createdAt: now() })
    .returning({ id: users.id })
    .get().id;
  userId = db
    .insert(users)
    .values({ username: "user1", passwordHash: "x", role: "user", points: 0, createdAt: now() })
    .returning({ id: users.id })
    .get().id;
  matchId = createManualMatch({
    leagueCode: "INT",
    homeName: "阿根廷",
    awayName: "法国",
    kickoffAt: now() + 86_400_000,
    neutral: true,
    round: "决赛",
  });
  analysisId = insertDraftAnalysis(matchId);
  // 走正规发布通道（analyzed → published + 定价）
  db.update(matches).set({ status: "analyzed" }).where(eq(matches.id, matchId)).run();
  publishAnalysisRow(analysisId, { adminId, pricePoints: 30 });
});

describe("积分与解锁", () => {
  it("管理员加分，流水与余额一致", () => {
    const r = adminAdjustPoints({ adminId, userId, delta: 100, note: "首充" });
    expect(r.balanceAfter).toBe(100);
    const u = db.select().from(users).where(eq(users.id, userId)).get()!;
    expect(u.points).toBe(100);
  });

  it("解锁扣费，重复解锁幂等只扣一次", () => {
    const first = unlockMatch(userId, matchId);
    expect(first.alreadyUnlocked).toBe(false);
    expect(first.pointsSpent).toBe(30);
    expect(first.balanceAfter).toBe(70);
    const second = unlockMatch(userId, matchId);
    expect(second.alreadyUnlocked).toBe(true);
    const u = db.select().from(users).where(eq(users.id, userId)).get()!;
    expect(u.points).toBe(70);
    expect(hasUnlocked(userId, matchId)).toBe(true);
  });

  it("余额不足拒绝且不产生脏数据", () => {
    const m2 = createManualMatch({
      leagueCode: "INT",
      homeName: "巴西",
      awayName: "德国",
      kickoffAt: now() + 86_400_000,
      neutral: true,
    });
    const a2 = insertDraftAnalysis(m2);
    db.update(matches).set({ status: "analyzed" }).where(eq(matches.id, m2)).run();
    publishAnalysisRow(a2, { pricePoints: 999 });
    expect(() => unlockMatch(userId, m2)).toThrow(HttpError);
    const u = db.select().from(users).where(eq(users.id, userId)).get()!;
    expect(u.points).toBe(70);
    expect(hasUnlocked(userId, m2)).toBe(false);
  });

  it("退款后 balance_after 流水连续", () => {
    const refunded = refundMatchUnlocks(matchId, "测试退款");
    expect(refunded).toBe(1);
    const rows = db.select().from(pointTransactions).where(eq(pointTransactions.userId, userId)).all();
    // 逐笔校验 balanceAfter = 前一笔 + delta
    let prev = 0;
    for (const tx of rows) {
      expect(tx.balanceAfter).toBe(prev + tx.delta);
      prev = tx.balanceAfter;
    }
    expect(prev).toBe(100); // 100 充值 −30 解锁 +30 退款
  });

  it("管理员减分不能把余额减成负数", () => {
    expect(() => adminAdjustPoints({ adminId, userId, delta: -99999 })).toThrow(HttpError);
  });
});

describe("发布锁定与哈希链", () => {
  it("已发布的报告不可再编辑", () => {
    expect(() => updateDraftSections(analysisId, { thesis: "篡改" }, adminId)).toThrow(HttpError);
  });

  it("verify 通过 → 篡改一字符 → verify 报错", () => {
    const ok = verifyAnalysis(analysisId);
    expect(ok.valid).toBe(true);
    const row = db.select().from(analyses).where(eq(analyses.id, analysisId)).get()!;
    db.update(analyses)
      .set({ reportMd: row.reportMd + "​" }) // 篡改：追加零宽字符
      .where(eq(analyses.id, analysisId))
      .run();
    const bad = verifyAnalysis(analysisId);
    expect(bad.valid).toBe(false);
    expect(bad.computedHash).not.toBe(bad.storedHash);
    // 还原
    db.update(analyses).set({ reportMd: row.reportMd }).where(eq(analyses.id, analysisId)).run();
    expect(verifyAnalysis(analysisId).valid).toBe(true);
  });

  it("哈希链：第二份发布的 prevHash 指向第一份", () => {
    const rows = db.select().from(analyses).all().filter((a) => a.publishedAt);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const sorted = rows.sort((x, y) => x.publishedAt! - y.publishedAt! || x.id - y.id);
    expect(sorted[1].prevHash).toBe(sorted[0].contentHash);
    expect(sorted[0].contentHash).toBe(computeAnalysisHash(sorted[0]));
  });
});
