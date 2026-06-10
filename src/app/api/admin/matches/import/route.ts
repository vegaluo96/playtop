import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { syncFixtures } from "@/server/services/matchesService";
import { logAudit } from "@/server/services/audit";

/** 从 fixtures.csv 导入启用联赛的未来赛程（含即时赔率快照） */
export async function POST() {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const result = await syncFixtures(true, true);
    logAudit({ actorId: admin.id, action: "import_fixtures", entity: "match", detail: result });
    return jsonOk(result);
  });
}
