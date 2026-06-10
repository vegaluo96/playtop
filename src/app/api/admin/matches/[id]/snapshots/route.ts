import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { SNAPSHOT_KINDS } from "@/server/db/schema";
import { insertSnapshot } from "@/server/services/snapshots";
import { logAudit } from "@/server/services/audit";

const inputSchema = z.object({
  kind: z.enum(SNAPSHOT_KINDS),
  payload: z.unknown(),
});

/** 手动录入降级通道：任何维度都可人工补录（payload 仍走同一归一化 zod 校验） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const { kind, payload } = inputSchema.parse(await req.json());
    const result = insertSnapshot(Number(id), kind, "manual", payload);
    logAudit({ actorId: admin.id, action: "manual_snapshot", entity: "match", entityId: Number(id), detail: { kind } });
    return jsonOk(result);
  });
}
