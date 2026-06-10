import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { matches, unlocks } from "../db/schema";
import { HttpError } from "../lib/api";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { applyPointsChange } from "./points";

/** 可解锁状态：已发布之后、转公开之前 */
const UNLOCKABLE = new Set(["published", "in_play", "finished"]);

/**
 * 解锁一场比赛的研报（覆盖赛前所有实时改版）。
 * 事务内：查重（UNIQUE 兜底）→ 扣分 → 解锁行 → 流水。幂等：已解锁直接返回。
 */
export function unlockMatch(
  userId: number,
  matchId: number,
): { alreadyUnlocked: boolean; pointsSpent: number; balanceAfter: number | null } {
  return db.transaction((tx) => {
    const match = tx.select().from(matches).where(eq(matches.id, matchId)).get();
    if (!match) throw new HttpError(404, "比赛不存在");
    const existing = tx
      .select()
      .from(unlocks)
      .where(and(eq(unlocks.userId, userId), eq(unlocks.matchId, matchId)))
      .get();
    if (existing) {
      return { alreadyUnlocked: true, pointsSpent: existing.pointsSpent, balanceAfter: null };
    }
    if (!UNLOCKABLE.has(match.status)) {
      throw new HttpError(400, match.status === "settled" ? "本场报告已免费公开" : "本场报告尚未发布");
    }
    const price = match.pricePoints ?? getConfig("pricing").defaultPricePoints;
    const { balanceAfter } = applyPointsChange(tx, {
      userId,
      delta: -price,
      type: "unlock",
      refMatchId: matchId,
      note: "解锁赛前研报",
    });
    tx.insert(unlocks).values({ userId, matchId, pointsSpent: price, createdAt: now() }).run();
    return { alreadyUnlocked: false, pointsSpent: price, balanceAfter };
  });
}

/** 比赛作废（腰斩/延期/管理员 void）时全额退款，幂等由调用方的状态机迁移保证 */
export function refundMatchUnlocks(matchId: number, note: string): number {
  return db.transaction((tx) => {
    const rows = tx.select().from(unlocks).where(eq(unlocks.matchId, matchId)).all();
    for (const u of rows) {
      applyPointsChange(tx, {
        userId: u.userId,
        delta: u.pointsSpent,
        type: "refund",
        refMatchId: matchId,
        note,
      });
    }
    return rows.length;
  });
}

export function hasUnlocked(userId: number, matchId: number): boolean {
  return !!db
    .select({ id: unlocks.id })
    .from(unlocks)
    .where(and(eq(unlocks.userId, userId), eq(unlocks.matchId, matchId)))
    .get();
}
