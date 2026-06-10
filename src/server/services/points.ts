import { eq } from "drizzle-orm";
import { db, type DB } from "../db";
import { pointTransactions, users } from "../db/schema";
import { HttpError } from "../lib/api";
import { now } from "../lib/time";
import { logAudit } from "./audit";

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export type PointChangeType = "admin_grant" | "admin_deduct" | "unlock" | "refund";

/**
 * 积分变动唯一入口：余额校验 + 更新 + append-only 流水，必须在事务内调用。
 * better-sqlite3 同步事务保证原子性（解锁并发不会超扣）。
 */
export function applyPointsChange(
  tx: Tx,
  input: {
    userId: number;
    delta: number;
    type: PointChangeType;
    refMatchId?: number;
    note?: string;
    adminId?: number;
  },
): { balanceAfter: number } {
  const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
  if (!user) throw new HttpError(404, "用户不存在");
  const balanceAfter = user.points + input.delta;
  if (balanceAfter < 0) throw new HttpError(400, "积分不足，请联系管理员充值");
  tx.update(users).set({ points: balanceAfter }).where(eq(users.id, input.userId)).run();
  tx.insert(pointTransactions)
    .values({
      userId: input.userId,
      delta: input.delta,
      balanceAfter,
      type: input.type,
      refMatchId: input.refMatchId ?? null,
      note: input.note ?? null,
      adminId: input.adminId ?? null,
      createdAt: now(),
    })
    .run();
  return { balanceAfter };
}

/** 管理员手动加/减积分（唯一的积分进入渠道——产品无自助充值） */
export function adminAdjustPoints(input: {
  adminId: number;
  userId: number;
  delta: number;
  note?: string;
}): { balanceAfter: number } {
  if (input.delta === 0) throw new HttpError(400, "变动值不能为 0");
  const result = db.transaction((tx) =>
    applyPointsChange(tx, {
      userId: input.userId,
      delta: input.delta,
      type: input.delta > 0 ? "admin_grant" : "admin_deduct",
      note: input.note,
      adminId: input.adminId,
    }),
  );
  logAudit({
    actorId: input.adminId,
    action: input.delta > 0 ? "grant_points" : "deduct_points",
    entity: "user",
    entityId: input.userId,
    detail: { delta: input.delta, note: input.note, balanceAfter: result.balanceAfter },
  });
  return result;
}
