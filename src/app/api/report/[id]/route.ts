/** AI 分析报告:GET /api/report/<fixtureId>?tz=(锁定时只回概率与七维) */
import { NextRequest, NextResponse } from "next/server";
import { hhmm } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { matchPanorama } from "@/server/af/panorama";
import { isLive } from "@/server/af/schedule";
import { buildReport } from "@/server/views/report";
import { currentUser } from "@/server/platform/session";
import { unlockPrice } from "@/server/platform/rules";
import { isUnlocked } from "@/server/platform/wallet";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fid = Number(id);
  if (!fid) return NextResponse.json({ ok: false, error: "无效的比赛 id" }, { status: 400 });
  const tz = req.nextUrl.searchParams.get("tz") || "UTC+8";
  const p = await matchPanorama(fid);
  if (!p) return NextResponse.json({ ok: false, error: "比赛不存在或数据未就绪" }, { status: 404 });
  const user = await currentUser();
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const unlocked = !!user && isUnlocked(user.id, fid, today);
  const { ps, secs } = buildReport(p);
  const fx = p.fixture;
  return NextResponse.json({
    ok: true,
    id: fid,
    match: `${fx.home_name} vs ${fx.away_name}`,
    league: leagueZh(fx.league_id, fx.league_name),
    leagueId: fx.league_id,
    time: isLive(fx.status) ? `${fx.elapsed ?? ""}' 进行中` : `${hhmm(fx.kickoff_utc, tz)}`,
    pH: ps?.pH ?? 0, pD: ps?.pD ?? 0, pA: ps?.pA ?? 0,
    comparison: ps?.comparison ?? {},
    homeName: fx.home_name,
    awayName: fx.away_name,
    advice: unlocked ? (ps?.advice ?? "样本不足") : null,
    sections: unlocked ? secs : [],
    locked: !unlocked,
    loggedIn: !!user,
    price: unlockPrice(fx.kickoff_utc, Date.now()),
  });
}
