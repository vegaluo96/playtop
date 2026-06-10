import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { advanceMatch } from "@/server/services/automation";
import { logAudit } from "@/server/services/audit";

/** 立即推进：与调度器同一编排器（采集→建模→发布→改版），手动加速不等 30 分钟 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const steps = await advanceMatch(Number(id), { collect: true });
    logAudit({ actorId: admin.id, action: "manual_advance", entity: "match", entityId: Number(id), detail: { steps } });
    return jsonOk({ steps: steps.length ? steps : ["当前状态无可自动推进的步骤"] });
  });
}
