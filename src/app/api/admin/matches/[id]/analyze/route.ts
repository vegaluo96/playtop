import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { analyzeMatch } from "@/server/services/analyze";
import { logAudit } from "@/server/services/audit";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const result = await analyzeMatch(Number(id), { autoPublishRevision: true });
    logAudit({ actorId: admin.id, action: "analyze", entity: "match", entityId: Number(id), detail: result });
    return jsonOk(result);
  });
}
