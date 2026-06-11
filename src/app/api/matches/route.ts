/**
 * 赛事列表:GET /api/matches?day=live|today|tmr|sat&league=all|<id>&tz=UTC+8
 * 免注册边界(服务端打码):直播行完整;非直播行前 3 条完整,其余打码。
 */
import { NextRequest, NextResponse } from "next/server";
import { parseTzOffset } from "@/lib/format";
import { fixturesBetween, dailyFreeSetToday, liveAwareSeries, movedRecently, hiddenFixtureIds } from "@/server/views/list-helpers";
import { marketCell } from "@/server/views/common";
import { isLive, isFinished } from "@/server/af/schedule";
import { currentUser } from "@/server/platform/session";
import { guestMasked } from "@/server/platform/rules";
import { isUnlocked } from "@/server/platform/wallet";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const day = q.get("day") || "today";
  const league = q.get("league") || "all";
  const off = parseTzOffset(q.get("tz") || "UTC+8");
  const user = await currentUser();

  const now = Date.now();
  const dayStart = Math.floor((now + off * 3_600_000) / 86_400_000) * 86_400_000 - off * 3_600_000;
  let from = dayStart;
  let to = dayStart + 86_400_000;
  const dn = /^d(\d{1,2})$/.exec(day); // d0..d13:今日起第 N 天(worker 已缓存 14 天日表)
  if (day === "tmr") {
    from += 86_400_000;
    to += 86_400_000;
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
  }

  const hidden = hiddenFixtureIds();
  let fixtures = fixturesBetween(from, to).filter((f) => !hidden.has(f.fixture_id));
  if (day === "live") fixtures = fixtures.filter((f) => isLive(f.status));
  if (league !== "all") fixtures = fixtures.filter((f) => f.league_id === Number(league));
  fixtures.sort((a, b) => a.kickoff_utc - b.kickoff_utc);

  const freeSet = dailyFreeSetToday();
  const liveCount = fixturesBetween(now - 4 * 3_600_000, now + 5 * 60_000).filter((f) => isLive(f.status)).length;

  let maskIndex = 0;
  const rows = fixtures.map((f) => {
    const live = isLive(f.status);
    const fin = isFinished(f.status);
    const masked = !user && guestMasked(live ? 0 : maskIndex++, live);
    const ah = marketCell(liveAwareSeries(f.fixture_id, "ah", live), "ah");
    const ou = marketCell(liveAwareSeries(f.fixture_id, "ou", live), "ou");
    const eu = marketCell(liveAwareSeries(f.fixture_id, "eu", live), "eu");
    const unlocked = user ? isUnlocked(user.id, f.fixture_id, todayStr()) : false;
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
      home: f.home_name,
      away: f.away_name,
      homeId: f.home_id,
      awayId: f.away_id,
      moved: !masked && movedRecently(f.fixture_id),
      masked,
      free: freeSet.has(f.fixture_id),
      unlocked,
      ah: masked ? null : ah,
      ou: masked ? null : ou,
      eu: masked ? null : eu,
    };
  });

  return NextResponse.json({ ok: true, rows, liveCount, loggedIn: !!user });
}

function todayStr(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
