import { handleRoute, jsonErr, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { testApiyiConnection } from "@/server/llm/apiyi";

export async function POST() {
  return handleRoute(async () => {
    await requireAdmin();
    try {
      return jsonOk(await testApiyiConnection());
    } catch (e) {
      return jsonErr(502, e instanceof Error ? e.message : "连接失败");
    }
  });
}
