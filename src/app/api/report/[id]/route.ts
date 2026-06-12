/** AI 分析报告:GET /api/report/<fixtureId>?tz=(锁定时只回概率与七维) */
import { NextRequest, NextResponse } from "next/server";
import { hhmm } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { matchPanorama } from "@/server/af/panorama";
import { isLive } from "@/server/af/schedule";
import { buildReport } from "@/server/views/report";
import { getLlmReport, getReportVersion, listReportVersions, reportLocked } from "@/server/llm/report";
import { currentUser } from "@/server/platform/session";
import { cfgUnlockPrice } from "@/server/platform/config";
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
  let sections = secs;
  let genBy = "template";
  let versions = listReportVersions(fid);
  const reqVer = Number(req.nextUrl.searchParams.get("v")) || null;
  let curVer: number | null = null;
  if (unlocked) {
    if (reqVer != null) {
      // 历史版本回看
      const v = getReportVersion(fid, reqVer);
      if (v) {
        sections = v.sections;
        genBy = v.model;
        curVer = reqVer;
      }
    }
    if (curVer == null) {
      const llm = await getLlmReport(p, secs).catch(() => null);
      if (llm) {
        sections = llm.sections;
        genBy = llm.by;
        versions = listReportVersions(fid);
        curVer = versions.length > 0 ? versions[versions.length - 1].ver : null;
      }
    }
  }
  const fx = p.fixture;
  const lockedFinal = reportLocked(fx.status);
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
    sections: unlocked ? sections : [],
    genBy,
    versions: unlocked ? versions.map((v) => ({ ver: v.ver, genAt: v.gen_at, changed: v.changed })) : [],
    ver: curVer,
    lockedFinal,
    locked: !unlocked,
    loggedIn: !!user,
    price: cfgUnlockPrice(fx.kickoff_utc, Date.now()),
  });
}
