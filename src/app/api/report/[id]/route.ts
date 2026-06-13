/** AI 概率报告:GET /api/report/<fixtureId>?tz=(锁定时只回概率与七维) */
import { NextRequest, NextResponse } from "next/server";
import { hhmm } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { nameZh } from "@/server/views/names";
import { matchPanorama } from "@/server/af/panorama";
import { isLive } from "@/server/af/schedule";
import { buildReport, buildReportSummary } from "@/server/views/report";
import { buildReportSignals, publicComparison, publicProbability, publicReportAdvice } from "@/server/views/report-signals";
import { findPolymarketSignal } from "@/server/external/polymarket";
import { getLlmReport, getReportVersion, listReportVersions, reportLocked } from "@/server/llm/report";
import { currentUser } from "@/server/platform/session";
import { cfgUnlockPrice } from "@/server/platform/config";
import { isUnlocked } from "@/server/platform/wallet";
import { publicMarketOverview } from "@/server/markets/overview";
import { buildReportSourceCoverage, publicSourceCoverage, sourceCoverageNeedsRebuild } from "@/server/views/source-coverage";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fid = Number(id);
  if (!fid) return NextResponse.json({ ok: false, error: "无效的比赛 id" }, { status: 400 });
  const tz = req.nextUrl.searchParams.get("tz") || "UTC+8";
  const user = await currentUser();
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const unlocked = !!user && isUnlocked(user.id, fid, today);
  const p = await matchPanorama(fid, { injuries: true, deep: unlocked, preKickoffOnly: true });
  if (!p) return NextResponse.json({ ok: false, error: "比赛不存在或数据未就绪" }, { status: 404 });
  const ps0 = buildReportSummary(p);
  const market = unlocked
    ? await findPolymarketSignal(p.fixture.home_name, p.fixture.away_name, { fixtureId: p.fixture.fixture_id, kickoffAt: p.fixture.kickoff_utc })
    : { status: "skipped" as const, note: "报告未解锁,暂不请求外部预测市场" };
  const signals = buildReportSignals(ps0, p.odds, market, p);
  const built = unlocked ? buildReport(p, signals) : { ps: ps0, secs: [], signals };
  const { ps, secs } = built;
  let sections = secs;
  let genBy = "template";
  let versions: ReturnType<typeof listReportVersions> = [];
  const reqVer = Number(req.nextUrl.searchParams.get("v")) || null;
  let curVer: number | null = null;
  let reportGeneratedAt: number | null = null;
  if (unlocked) {
    versions = listReportVersions(fid);
    if (reqVer != null) {
      // 历史版本回看
      const v = getReportVersion(fid, reqVer);
      if (v) {
        sections = v.sections;
        genBy = v.model;
        curVer = reqVer;
        reportGeneratedAt = v.gen_at;
      }
    }
    if (curVer == null) {
      const llm = await getLlmReport(p, secs).catch(() => null);
      if (llm) {
        sections = llm.sections;
        genBy = llm.by;
        versions = listReportVersions(fid);
        const latest = versions[versions.length - 1] ?? null;
        curVer = latest?.ver ?? null;
        reportGeneratedAt = latest?.gen_at ?? null;
      }
    }
  }
  const fx = p.fixture;
  const homeZh = nameZh(fx.home_name);
  const awayZh = nameZh(fx.away_name);
  const lockedFinal = reportLocked(fx.status);
  const prob = publicProbability(ps);
  const comp = publicComparison(ps);
  const advice = publicReportAdvice(ps, signals);
  const coverage = buildReportSourceCoverage(p, signals, { reportGeneratedAt });
  const publicCoverage = publicSourceCoverage(coverage);
  return NextResponse.json({
    ok: true,
    id: fid,
    match: `${homeZh} vs ${awayZh}`,
    league: leagueZh(fx.league_id, fx.league_name),
    leagueId: fx.league_id,
    time: isLive(fx.status) ? `${fx.elapsed ?? ""}' 进行中` : `${hhmm(fx.kickoff_utc, tz)}`,
    pH: prob.pH, pD: prob.pD, pA: prob.pA,
    probReady: prob.probReady,
    comparison: comp.comparison,
    comparisonReady: comp.comparisonReady,
    homeName: homeZh,
    awayName: awayZh,
    advice: unlocked ? advice.advice : null,
    summaryReady: unlocked ? advice.summaryReady : false,
    directions: unlocked ? { ah: signals.ah, ou: signals.ou } : null,
    model: unlocked ? signals.model : null,
    market: unlocked ? signals.market : null,
    marketOverview: publicMarketOverview(p.marketOverview),
    sourceCoverage: publicCoverage,
    sourceCoverageNeedsRebuild: sourceCoverageNeedsRebuild(coverage),
    fittingScope: unlocked ? "fullReport" : "preview",
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
