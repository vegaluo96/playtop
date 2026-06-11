/**
 * 预测列表:GET /api/predictions?tz=
 * 轻量卡:概率条免费可见;建议/胜者/大小/进球上限 + AI 报告 = 唯一付费项。
 */
import { NextRequest, NextResponse } from "next/server";
import { hhmm, parseTzOffset } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { fixtureById, fixturesBetween, latestPrediction, modelStats, oddsSeries } from "@/server/af/store";
import { isLive } from "@/server/af/schedule";
import { currentUser } from "@/server/platform/session";
import { cfgUnlockPrice } from "@/server/platform/config";
import { dailyFreeFixtureIds, isUnlocked } from "@/server/platform/wallet";
import { predSummary } from "@/server/views/common";
import { nameZh } from "@/server/views/names";

export async function GET(req: NextRequest) {
  const tz = req.nextUrl.searchParams.get("tz") || "UTC+8";
  const fixtureParam = Number(req.nextUrl.searchParams.get("fixture")) || null;
  const off = parseTzOffset(tz);
  const user = await currentUser();
  const now = Date.now();
  const dayStart = Math.floor((now + off * 3_600_000) / 86_400_000) * 86_400_000 - off * 3_600_000;
  // fixture 参数:单场卡(不限今日;桌面右栏「官方预测 · 本场」用)
  const fixtures = fixtureParam
    ? [fixtureById(fixtureParam)].filter((f) => f != null)
    : fixturesBetween(dayStart, dayStart + 86_400_000).sort((a, b) => a.kickoff_utc - b.kickoff_utc);
  const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const freeSet = new Set(dailyFreeFixtureIds(today));

  const cards = fixtures
    .map((f) => {
      const lastSnap = (mk: "ah" | "ou") => {
        const s = oddsSeries(f.fixture_id, mk);
        const r = s[s.length - 1];
        return r ? { line: r.line, h: r.h, a: r.a } : null;
      };
      const ps = predSummary(latestPrediction(f.fixture_id), f.home_id, {
        ah: lastSnap("ah"), ou: lastSnap("ou"), homeName: nameZh(f.home_name), awayName: nameZh(f.away_name),
      });
      if (!ps) return null;
      const unlocked = !!user && isUnlocked(user.id, f.fixture_id, today);
      const price = cfgUnlockPrice(f.kickoff_utc, now);
      return {
        id: f.fixture_id,
        match: `${nameZh(f.home_name)} vs ${nameZh(f.away_name)}`,
        league: leagueZh(f.league_id, f.league_name),
        leagueId: f.league_id,
        time: hhmm(f.kickoff_utc, tz),
        live: isLive(f.status),
        free: freeSet.has(f.fixture_id),
        pH: ps.pH, pD: ps.pD, pA: ps.pA,
        locked: !unlocked,
        price,
        lockText: !user ? "注册领 58 积分 · 免费解锁 1 场预测" : `解锁本场预测 · ${price} 积分`,
        advice: unlocked ? ps.advice : null,
        winnerText: unlocked ? ps.winnerName + (ps.winDraw ? " / 平" : "") : null,
        uoText: unlocked && ps.uoText ? `${ps.uoLine} ${ps.uoText}` : unlocked ? "暂无方向" : null,
        goalsText: unlocked ? `主 ${ps.goalsHome ?? "—"} 客 ${ps.goalsAway ?? "—"}` : null,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ ok: true, cards, record: modelStats(now), loggedIn: !!user });
}
