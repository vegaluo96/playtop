/**
 * 赛事列表:GET /api/matches?day=live|soon|today|results|tmr|pN|dN|sat&league=all|<id>&tz=UTC+8
 * 免注册边界(服务端打码):直播行完整;非直播行前 3 条完整,其余打码。
 */
import { NextRequest, NextResponse } from "next/server";
import { parseTzOffset } from "@/lib/format";
import {
  fixturesBetween,
  dailyFreeSetToday,
  hiddenFixtureIds,
  liveAwareSeriesBatch,
  liveExtras,
  movedRecentlyMap,
} from "@/server/views/list-helpers";
import { marketCell } from "@/server/views/common";
import { mainOddsDecisionBatch } from "@/server/af/store";
import { isLive, isFinished } from "@/server/af/schedule";
import { currentUser } from "@/server/platform/session";
import { guestMasked } from "@/server/platform/rules";
import { unlockedIds } from "@/server/platform/wallet";
import { nameZh } from "@/server/views/names";
import { teamLogoFromFixturePayload } from "@/server/views/team-assets";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const day = q.get("day") || "today";
  const league = q.get("league") || "all";
  const off = parseTzOffset(q.get("tz") || "UTC+8");
  const userPromise = currentUser();

  const now = Date.now();
  const dayStart = Math.floor((now + off * 3_600_000) / 86_400_000) * 86_400_000 - off * 3_600_000;
  let from = dayStart;
  let to = dayStart + 86_400_000;
  const dn = /^d(\d{1,2})$/.exec(day); // d0..d13:今日起第 N 天(worker 已缓存 14 天日表)
  const pn = /^p(\d{1,2})$/.exec(day); // p1..p14:过去第 N 天,仅展示已完场赛果
  const resultsMode = day === "results" || !!pn;
  if (day === "tmr") {
    from += 86_400_000;
    to += 86_400_000;
  } else if (day === "yday") {
    from -= 86_400_000;
    to -= 86_400_000;
  } else if (pn) {
    const n = Math.min(14, Math.max(1, Number(pn[1])));
    from = dayStart - n * 86_400_000;
    to = from + 86_400_000;
  } else if (dn) {
    const n = Math.min(13, Math.max(0, Number(dn[1])));
    from = dayStart + n * 86_400_000;
    to = from + 86_400_000;
  } else if (day === "sat") {
    // 旧入口兼容:下一个周六
    const dow = new Date(dayStart + off * 3_600_000).getUTCDay();
    const ahead = ((6 - dow) % 7 + 7) % 7 || 7;
    from = dayStart + ahead * 86_400_000;
    to = from + 86_400_000;
  } else if (day === "live") {
    from = now - 4 * 3_600_000;
    to = now + 5 * 60_000;
  } else if (day === "soon") {
    // 即将(默认视图):滚球在最上 + 未来 24h 即将开赛,跨自然日连续,对齐球盘站习惯
    from = now - 4 * 3_600_000;
    to = now + 24 * 3_600_000;
  } else if (day === "results") {
    // 赛果:最近 72 小时已完场,作为首页历史入口;更早按 pN 精确日期查询。
    from = dayStart - 2 * 86_400_000;
    to = now;
  }

  const hidden = hiddenFixtureIds();
  let fixtures = fixturesBetween(from, to).filter((f) => !hidden.has(f.fixture_id));
  if (day === "live") fixtures = fixtures.filter((f) => isLive(f.status));
  if (day === "soon") fixtures = fixtures.filter((f) => isLive(f.status) || (!isFinished(f.status) && f.kickoff_utc >= now - 10 * 60_000));
  if (resultsMode) fixtures = fixtures.filter((f) => isFinished(f.status));
  if (league !== "all") fixtures = fixtures.filter((f) => f.league_id === Number(league));
  fixtures.sort((a, b) => (resultsMode ? b.kickoff_utc - a.kickoff_utc : a.kickoff_utc - b.kickoff_utc));

  const user = await userPromise;
  const freeSet = dailyFreeSetToday();
  const unlockedSet = user ? new Set(unlockedIds(user.id)) : new Set<number>();
  const liveCount = fixturesBetween(now - 4 * 3_600_000, now + 5 * 60_000).filter((f) => isLive(f.status)).length;
  const maskedByFixture = new Map<number, boolean>();
  let previewMaskIndex = 0;
  for (const f of fixtures) {
    const live = isLive(f.status);
    maskedByFixture.set(f.fixture_id, !user && guestMasked(live ? 0 : previewMaskIndex++, live));
  }
  const visibleFixtureIds = fixtures.filter((f) => !maskedByFixture.get(f.fixture_id)).map((f) => f.fixture_id);
  const liveFixtureIds = new Set(fixtures.filter((f) => !maskedByFixture.get(f.fixture_id) && isLive(f.status)).map((f) => f.fixture_id));
  const ahSeries = liveAwareSeriesBatch(visibleFixtureIds, "ah", liveFixtureIds);
  const ouSeries = liveAwareSeriesBatch(visibleFixtureIds, "ou", liveFixtureIds);
  const euSeries = liveAwareSeriesBatch(visibleFixtureIds, "eu", liveFixtureIds);
  const movedMap = movedRecentlyMap(visibleFixtureIds);
  // 赛前数据质量分(与详情 MarketOverview 同源 mainOddsDecision;滚球/完场无赛前分,置 null)
  const preFixtureIds = fixtures.filter((f) => !maskedByFixture.get(f.fixture_id) && !isLive(f.status)).map((f) => f.fixture_id);
  const ahDec = mainOddsDecisionBatch(preFixtureIds, "ah");
  const ouDec = mainOddsDecisionBatch(preFixtureIds, "ou");
  const euDec = mainOddsDecisionBatch(preFixtureIds, "eu");
  const today = todayStr();

  const rows = fixtures.map((f) => {
    const live = isLive(f.status);
    const fin = isFinished(f.status);
    const masked = maskedByFixture.get(f.fixture_id) ?? false;
    const ah = masked ? null : marketCell(ahSeries.get(f.fixture_id) ?? [], "ah");
    const ou = masked ? null : marketCell(ouSeries.get(f.fixture_id) ?? [], "ou");
    const eu = masked ? null : marketCell(euSeries.get(f.fixture_id) ?? [], "eu");
    // q = 已展示市场的最低质量分(与详情 dataQualityScore 同口径);滚球/完场/打码为 null
    const q =
      masked || live
        ? null
        : (() => {
            const ss = [
              ah && ahDec.get(f.fixture_id)?.qualityScore,
              ou && ouDec.get(f.fixture_id)?.qualityScore,
              eu && euDec.get(f.fixture_id)?.qualityScore,
            ].filter((s): s is number => typeof s === "number" && s > 0);
            return ss.length > 0 ? Math.min(...ss) : null;
          })();
    const unlocked = user ? freeSet.has(f.fixture_id) || unlockedSet.has(f.fixture_id) : false;
    return {
      id: f.fixture_id,
      leagueId: f.league_id,
      leagueName: f.league_name,
      kickoff: f.kickoff_utc,
      live,
      finished: fin,
      elapsed: f.elapsed,
      ht: f.status === "HT",
      score: f.goals_home != null && f.goals_away != null ? `${f.goals_home}-${f.goals_away}` : null,
      home: nameZh(f.home_name),
      away: nameZh(f.away_name),
      homeId: f.home_id,
      awayId: f.away_id,
      homeLogo: teamLogoFromFixturePayload(f.payload, "home"),
      awayLogo: teamLogoFromFixturePayload(f.payload, "away"),
      moved: !masked && (movedMap.get(f.fixture_id) ?? false),
      ex: (live || fin) && !masked ? liveExtras(f.payload) : null, // 滚球+完场都给角球/红牌/半场,卡片右上展示
      masked,
      free: freeSet.has(f.fixture_id),
      unlocked,
      q,
      ah,
      ou,
      eu,
    };
  });

  return NextResponse.json({ ok: true, rows, liveCount, loggedIn: !!user });
}

function todayStr(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
