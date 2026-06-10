import { desc, eq, and } from "drizzle-orm";
import { db } from "../db";
import { auditHashes } from "../db/schema";
import { hashObject } from "../lib/hash";
import { now } from "../lib/time";

/**
 * V2 通用审计哈希链：每类实体一条链（entityType 维度），
 * 任何 V2 关键对象落库即 append 一节；删除/篡改任意一节都会断链。
 */
export function appendAuditHash(entityType: string, entityId: number, payload: unknown): { hash: string; prev: string | null } {
  const prev =
    db
      .select({ hashValue: auditHashes.hashValue })
      .from(auditHashes)
      .where(eq(auditHashes.entityType, entityType))
      .orderBy(desc(auditHashes.id))
      .limit(1)
      .get()?.hashValue ?? null;
  const hash = hashObject({ entityType, entityId, payload, prev });
  db.insert(auditHashes).values({ entityType, entityId, hashValue: hash, previousHash: prev, createdAt: now() }).run();
  return { hash, prev };
}

/** 校验某实体类型整条链（公开审计 API 用） */
export function verifyAuditChain(entityType: string): { ok: boolean; length: number; brokenAt: number | null } {
  const rows = db.select().from(auditHashes).where(eq(auditHashes.entityType, entityType)).orderBy(auditHashes.id).all();
  let prev: string | null = null;
  for (const r of rows) {
    if (r.previousHash !== prev) return { ok: false, length: rows.length, brokenAt: r.id };
    prev = r.hashValue;
  }
  return { ok: true, length: rows.length, brokenAt: null };
}

export function auditEntriesFor(entityType: string, entityId: number) {
  return db
    .select()
    .from(auditHashes)
    .where(and(eq(auditHashes.entityType, entityType), eq(auditHashes.entityId, entityId)))
    .orderBy(auditHashes.id)
    .all();
}
