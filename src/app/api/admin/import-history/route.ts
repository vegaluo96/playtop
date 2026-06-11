import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { getConfig } from "@/server/lib/config";
import { importInternationalHistory, importLeagueHistory } from "@/server/services/importHistory";
import { logAudit } from "@/server/services/audit";

const inputSchema = z.object({
  type: z.enum(["club", "international"]),
  leagues: z.array(z.string()).optional(),
  seasons: z.number().int().min(1).max(10).optional(),
  sinceYear: z.number().int().min(1990).optional(),
});

/** 历史赛果导入：本地交锋/近况统计底座（h2h、近期状态退化链用） */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const input = inputSchema.parse(await req.json());
    let result: unknown;
    if (input.type === "club") {
      const leagues = input.leagues ?? getConfig("datasources").enabledLeagues;
      const all = [];
      for (const code of leagues) {
        all.push(...(await importLeagueHistory(code, input.seasons ?? 3, true)));
      }
      result = all;
    } else {
      result = await importInternationalHistory(input.sinceYear ?? 2018, true);
    }
    logAudit({ actorId: admin.id, action: "import_history", entity: "system", detail: { input, result } });
    return jsonOk(result);
  });
}
