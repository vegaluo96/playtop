import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { getConfig, setConfig, type ConfigKey } from "@/server/lib/config";

export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    const apiyi = getConfig("apiyi");
    return jsonOk({
      // 不回传完整 key，只回传尾号
      apiyi: { ...apiyi, apiKey: apiyi.apiKey ? `****${apiyi.apiKey.slice(-4)}` : "" },
      datasources: getConfig("datasources"),
      engine: getConfig("engine"),
      pricing: getConfig("pricing"),
    });
  });
}

const putSchema = z.object({
  key: z.enum(["apiyi", "datasources", "engine", "pricing"]),
  value: z.record(z.string(), z.unknown()),
});

export async function PUT(req: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const { key, value } = putSchema.parse(await req.json());
    // apiyi key 特殊处理：传 **** 尾号表示不修改
    if (key === "apiyi") {
      const cur = getConfig("apiyi");
      const v = value as { apiKey?: string };
      if (!v.apiKey || v.apiKey.startsWith("****")) v.apiKey = cur.apiKey;
    }
    const saved = setConfig(key as ConfigKey, value);
    return jsonOk(key === "apiyi" ? { ...saved, apiKey: "(已保存)" } : saved);
  });
}
