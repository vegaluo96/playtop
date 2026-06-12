/**
 * AI 概率报告列表:GET /api/predictions?tz=
 * 轻量卡:概率条免费可见;方向摘要 + AI 报告 = 唯一付费项。
 */
import { NextRequest, NextResponse } from "next/server";
import { hhmm, parseTzOffset } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { fixtureById, fixturesBetween, latestPredictionsBeforeMap, modelStats, oddsSeriesBatchBefore } from "@/server/af/store";
import { isLive } from "@/server/af/schedule";
import { currentUser } from "@/server/platform/session";
import { cfgUnlockPrice } from "@/server/platform/config";
import { dailyFreeFixtureIds, unlockedIds } from "@/server/platform/wallet";
import { predSummary } from "@/server/views/common";
import { buildReportSignals, hasUsableProbability } from "@/server/views/report-signals";
import { nameZh } from "@/server/views/names";

export async function GET(req: NextRequest) {
  const tz = req.nextUrl.searchParams.get("tz") || "UTC+8";
  const fixtureParam = Number(req.nextUrl.searchParams.get("fixture")) || null;
  const off = parseTzOffset(tz);
  const userPromise = currentUser();
  const now = Date.now();
  const dayStart = Math.floor((now + off * 3_600_000) / 86_400_000) * 86_400_000 - off * 3_600_000;
  // fixture 参数:单场卡(不限今日;桌面右栏「AI 概率报告 · 本场」用)
  const fixtures = fixtureParam
    ? [fixtureById(fixtureParam)].filter((f) => f != null)
    : fixturesBetween(dayStart, dayStart + 86_400_000).sort((a, b) => a.kickoff_utc - b.kickoff_utc);
  const fixtureIds = fixtures.map((f) => f.fixture_id);
  const cutoffByFixture = new Map(fixtures.map((f) => [f.fixture_id, Math.min(now, f.kickoff_utc - 1)]));
  const predictions = latestPredictionsBeforeMap(fixtureIds, cutoffByFixture);
  const cardFixtures = fixtures.filter((f) => predictions.has(f.fixture_id));
  const cardFixtureIds = cardFixtures.map((f) => f.fixture_id);
  const ahSeries = oddsSeriesBatchBefore(cardFixtureIds, "ah", cutoffByFixture);
  const ouSeries = oddsSeriesBatchBefore(cardFixtureIds, "ou", cutoffByFixture);
  const today = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
  const freeSet = new Set(dailyFreeFixtureIds(today));
  const user = await userPromise;
  const unlockedSet = user ? new Set(unlockedIds(user.id)) : new Set<number>();

  const cards = cardFixtures
    .map((f) => {
      const lastSnap = (mk: "ah" | "ou") => {
        const s = (mk === "ah" ? ahSeries : ouSeries).get(f.fixture_id) ?? [];
        const r = s[s.length - 1];
        return r ? { line: r.line, h: r.h, a: r.a } : null;
      };
      const ps = predSummary(predictions.get(f.fixture_id) ?? null, f.home_id, {
        ah: lastSnap("ah"), ou: lastSnap("ou"), homeName: nameZh(f.home_name), awayName: nameZh(f.away_name),
      });
      if (!ps) return null;
      const signals = buildReportSignals(ps, {
        ah: ahSeries.get(f.fixture_id) ?? [],
        ou: ouSeries.get(f.fixture_id) ?? [],
      });
      const unlocked = !!user && (freeSet.has(f.fixture_id) || unlockedSet.has(f.fixture_id));
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
        probReady: hasUsableProbability(ps),
        locked: !unlocked,
        price,
        lockText: !user ? "登录查看报告额度说明" : `解锁本场报告 · ${price} 额度`,
        advice: unlocked ? signals.summary : null,
        winnerText: unlocked ? ps.winnerName + (ps.winDraw ? " / 平" : "") : null,
        ahText: unlocked ? signals.ah.text : null,
        uoText: unlocked ? signals.ou.text : null,
        goalsText: unlocked ? `覆盖 ${signals.model.coverage}%` : null,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ ok: true, cards, record: modelStats(now), loggedIn: !!user });
}
