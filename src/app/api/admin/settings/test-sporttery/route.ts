import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { getSportteryRows } from "@/server/services/oddsSync";

/** 竞彩接口连通性自检：境外 IP 可能被 WAF 拦截，部署后点一下就知道 */
export async function POST() {
  return handleRoute(async () => {
    await requireAdmin();
    const rows = await getSportteryRows(true);
    const withOdds = rows.filter((r) => r.oneXTwo);
    const worldCup = rows.filter((r) => /世界杯/.test(r.league));
    return jsonOk({
      ok: true,
      在售场次: rows.length,
      有赔率: withOdds.length,
      世界杯场次: worldCup.length,
      有让球: rows.filter((r) => r.hhad).length,
      有总进球: rows.filter((r) => r.totalGoals).length,
      有波胆: rows.filter((r) => r.correctScores.length > 0).length,
      样例: rows.slice(0, 3).map(
        (r) =>
          `${r.league} ${r.homeCn} vs ${r.awayCn}` +
          (r.oneXTwo ? ` @ ${r.oneXTwo.home}/${r.oneXTwo.draw}/${r.oneXTwo.away}` : "（暂无赔率）") +
          (r.correctScores.length ? ` 波胆×${r.correctScores.length}` : ""),
      ),
    });
  });
}
