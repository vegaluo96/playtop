import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { importWorldCupFixtures } from "@/server/services/importWorldCup";
import { logAudit } from "@/server/services/audit";

/** 一键导入世界杯 2026 赛程（openfootball 数据源，免 key；幂等可重复执行） */
export async function POST() {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const result = await importWorldCupFixtures(true);
    logAudit({ actorId: admin.id, action: "import_worldcup", entity: "match", detail: result });
    return jsonOk(result);
  });
}
