import { z } from "zod";
import { handleRoute, jsonErr, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { apiFootballConfigured } from "@/server/datasources/apiFootball";
import { afCatalogGrouped, runAfEndpoint } from "@/server/datasources/afCatalog";
import { rateLimitHit } from "@/server/lib/rateLimit";
import { logAudit } from "@/server/services/audit";

/** 套壳数据中心：列出 AF v3 全端点目录 + 连通状态 */
export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    return jsonOk({ configured: apiFootballConfigured(), catalog: afCatalogGrouped() });
  });
}

const querySchema = z.object({
  key: z.string().min(1),
  params: z.record(z.string(), z.string()).default({}),
});

/** 调用任意 AF v3 端点（白名单参数），返回原始信封；按管理员限速防配额误烧 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    if (!apiFootballConfigured()) {
      return jsonErr(400, "API-Football 未配置：在 系统设置→数据源 填入 key（或服务器 env API_FOOTBALL_KEY）");
    }
    const rl = rateLimitHit(`af-query:${admin.id}`, 30, 60_000);
    if (!rl.ok) return jsonErr(429, `调用过于频繁，请 ${rl.retryAfterSec} 秒后再试（保护 AF 配额）`);
    const { key, params } = querySchema.parse(await req.json());
    try {
      const result = await runAfEndpoint(key, params);
      logAudit({ actorId: admin.id, action: "af_query", entity: "system", detail: { key, params, results: result.results, ok: result.ok } });
      return jsonOk(result);
    } catch (e) {
      return jsonErr(502, e instanceof Error ? e.message : "AF 调用失败");
    }
  });
}
