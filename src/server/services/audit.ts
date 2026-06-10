import { db } from "../db";
import { auditLogs } from "../db/schema";
import { now } from "../lib/time";

export function logAudit(input: {
  actorId: number;
  action: string;
  entity: string;
  entityId?: number;
  detail?: unknown;
}): void {
  db.insert(auditLogs)
    .values({
      actorId: input.actorId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail),
      createdAt: now(),
    })
    .run();
}
