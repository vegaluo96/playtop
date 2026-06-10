import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { parsePolymarketSearch } from "@/server/datasources/polymarket";

/** Polymarket 接口连通性自检：拉一次公开搜索并报告解析出的市场数量与样例 */
export async function POST() {
  return handleRoute(async () => {
    await requireAdmin();
    const res = await fetch("https://gamma-api.polymarket.com/public-search?q=world%20cup&limit_per_type=10", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
    const events = parsePolymarketSearch(await res.text());
    return jsonOk({
      ok: true,
      解析到市场: events.length,
      样例: events.slice(0, 3).map((e) => `${e.title}（${e.outcomes.length} 个方向${e.startAt ? "" : "，无时间"}）`),
    });
  });
}
