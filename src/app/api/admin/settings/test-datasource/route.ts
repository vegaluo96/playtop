import { handleRoute, jsonErr, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { getConfig } from "@/server/lib/config";
import { now } from "@/server/lib/time";
import { fetchLeagueSeasonCsv, seasonCodes } from "@/server/datasources/footballDataCouk";
import { geocode } from "@/server/datasources/openMeteo";

/** 试拉一份 CSV + 一次地理编码，验证免 key 数据源连通性 */
export async function POST() {
  return handleRoute(async () => {
    await requireAdmin();
    const cfg = getConfig("datasources");
    const league = cfg.enabledLeagues[0] ?? "E0";
    const [season] = seasonCodes(now(), 1);
    try {
      const start = Date.now();
      const { rows } = await fetchLeagueSeasonCsv(cfg.csvBase, league, season, true);
      const geo = await geocode("Wembley Stadium");
      return jsonOk({
        csv: { league, season, rows: rows.length, latencyMs: Date.now() - start },
        geocoding: geo ? `OK（${geo.label}）` : "无结果",
      });
    } catch (e) {
      return jsonErr(502, e instanceof Error ? e.message : "数据源连接失败");
    }
  });
}
