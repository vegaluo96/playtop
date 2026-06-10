import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { historyMatches, teams } from "../db/schema";
import {
  formPayloadSchema,
  h2hPayloadSchema,
  standingsPayloadSchema,
  teamStatsPayloadSchema,
} from "./types";

/**
 * 本地历史库的确定性统计（零外部调用、可复现）：
 * 历史交锋 / 近期状态 / 赛季球队数据 / 积分榜。
 * 数据底座 = football-data.co.uk 历史导入 + 国际赛导入 + 本平台已结算赛果回填。
 */

function teamName(teamId: number): string {
  return db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).get()?.name ?? `#${teamId}`;
}

export function computeH2h(homeTeamId: number, awayTeamId: number, limit = 10): z.infer<typeof h2hPayloadSchema> {
  const rows = db
    .select()
    .from(historyMatches)
    .where(
      or(
        and(eq(historyMatches.homeTeamId, homeTeamId), eq(historyMatches.awayTeamId, awayTeamId)),
        and(eq(historyMatches.homeTeamId, awayTeamId), eq(historyMatches.awayTeamId, homeTeamId)),
      ),
    )
    .orderBy(desc(historyMatches.playedAt))
    .limit(limit)
    .all();
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  for (const r of rows) {
    const homePerspectiveGoals = r.homeTeamId === homeTeamId ? [r.homeGoals, r.awayGoals] : [r.awayGoals, r.homeGoals];
    if (homePerspectiveGoals[0] > homePerspectiveGoals[1]) homeWins++;
    else if (homePerspectiveGoals[0] === homePerspectiveGoals[1]) draws++;
    else awayWins++;
  }
  return h2hPayloadSchema.parse({
    matches: rows.map((r) => ({
      playedAt: r.playedAt,
      homeTeam: teamName(r.homeTeamId),
      awayTeam: teamName(r.awayTeamId),
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals,
      competition: r.season ?? undefined,
    })),
    summary: { total: rows.length, homeWins, draws, awayWins },
  });
}

function recentForTeam(teamId: number, limit: number) {
  const rows = db
    .select()
    .from(historyMatches)
    .where(or(eq(historyMatches.homeTeamId, teamId), eq(historyMatches.awayTeamId, teamId)))
    .orderBy(desc(historyMatches.playedAt))
    .limit(limit)
    .all();
  return rows.map((r) => {
    const isHome = r.homeTeamId === teamId;
    const stats = r.stats ? (JSON.parse(r.stats) as Record<string, number | null>) : {};
    return {
      playedAt: r.playedAt,
      opponent: teamName(isHome ? r.awayTeamId : r.homeTeamId),
      venue: (r.neutral ? "neutral" : isHome ? "home" : "away") as "home" | "away" | "neutral",
      goalsFor: isHome ? r.homeGoals : r.awayGoals,
      goalsAgainst: isHome ? r.awayGoals : r.homeGoals,
      shots: (isHome ? stats.homeShots : stats.awayShots) ?? undefined,
      shotsOnTarget: (isHome ? stats.homeSot : stats.awaySot) ?? undefined,
    };
  });
}

function formSummary(recent: ReturnType<typeof recentForTeam>): string {
  if (recent.length === 0) return "暂无近期比赛数据";
  const seq = recent
    .map((m) => (m.goalsFor > m.goalsAgainst ? "胜" : m.goalsFor === m.goalsAgainst ? "平" : "负"))
    .join("");
  const gf = recent.reduce((s, m) => s + m.goalsFor, 0);
  const ga = recent.reduce((s, m) => s + m.goalsAgainst, 0);
  return `近${recent.length}场 ${seq}，进${gf}失${ga}`;
}

export function computeForm(homeTeamId: number, awayTeamId: number, limit = 6): z.infer<typeof formPayloadSchema> {
  const home = recentForTeam(homeTeamId, limit);
  const away = recentForTeam(awayTeamId, limit);
  return formPayloadSchema.parse({
    home: { recent: home, summaryText: formSummary(home) },
    away: { recent: away, summaryText: formSummary(away) },
  });
}

function latestSeason(leagueId: number): string | null {
  const row = db
    .select({ season: historyMatches.season })
    .from(historyMatches)
    .where(eq(historyMatches.leagueId, leagueId))
    .orderBy(desc(historyMatches.playedAt))
    .limit(1)
    .get();
  return row?.season ?? null;
}

export function computeTeamStats(
  leagueId: number,
  homeTeamId: number,
  awayTeamId: number,
): z.infer<typeof teamStatsPayloadSchema> {
  const season = latestSeason(leagueId);
  const calc = (teamId: number, side: "home" | "away") => {
    const cond = [eq(historyMatches.leagueId, leagueId)];
    if (season) cond.push(eq(historyMatches.season, season));
    const rows = db
      .select()
      .from(historyMatches)
      .where(and(...cond, or(eq(historyMatches.homeTeamId, teamId), eq(historyMatches.awayTeamId, teamId))))
      .all();
    let gf = 0;
    let ga = 0;
    let cs = 0;
    let sideGf = 0;
    let sideGa = 0;
    let sideN = 0;
    for (const r of rows) {
      const isHome = r.homeTeamId === teamId;
      const f = isHome ? r.homeGoals : r.awayGoals;
      const a = isHome ? r.awayGoals : r.homeGoals;
      gf += f;
      ga += a;
      if (a === 0) cs++;
      if ((side === "home") === isHome) {
        sideGf += f;
        sideGa += a;
        sideN++;
      }
    }
    const n = rows.length;
    return {
      matches: n,
      gfPerGame: n ? gf / n : 0,
      gaPerGame: n ? ga / n : 0,
      cleanSheetRate: n ? cs / n : 0,
      sideGf: sideN ? sideGf / sideN : null,
      sideGa: sideN ? sideGa / sideN : null,
    };
  };
  const h = calc(homeTeamId, "home");
  const a = calc(awayTeamId, "away");
  return teamStatsPayloadSchema.parse({
    home: {
      matches: h.matches,
      gfPerGame: h.gfPerGame,
      gaPerGame: h.gaPerGame,
      cleanSheetRate: h.cleanSheetRate,
      homeGfPerGame: h.sideGf,
      homeGaPerGame: h.sideGa,
    },
    away: {
      matches: a.matches,
      gfPerGame: a.gfPerGame,
      gaPerGame: a.gaPerGame,
      cleanSheetRate: a.cleanSheetRate,
      awayGfPerGame: a.sideGf,
      awayGaPerGame: a.sideGa,
    },
  });
}

export function computeStandings(
  leagueId: number,
  homeTeamId: number,
  awayTeamId: number,
): z.infer<typeof standingsPayloadSchema> {
  const season = latestSeason(leagueId);
  const cond = [eq(historyMatches.leagueId, leagueId)];
  if (season) cond.push(eq(historyMatches.season, season));
  const rows = db
    .select()
    .from(historyMatches)
    .where(and(...cond))
    .all();
  const table = new Map<number, { points: number; played: number; gd: number }>();
  const bump = (id: number, pts: number, gd: number) => {
    const cur = table.get(id) ?? { points: 0, played: 0, gd: 0 };
    cur.points += pts;
    cur.played += 1;
    cur.gd += gd;
    table.set(id, cur);
  };
  for (const r of rows) {
    const diff = r.homeGoals - r.awayGoals;
    bump(r.homeTeamId, diff > 0 ? 3 : diff === 0 ? 1 : 0, diff);
    bump(r.awayTeamId, diff < 0 ? 3 : diff === 0 ? 1 : 0, -diff);
  }
  const ids = [...table.keys()];
  const names = ids.length
    ? new Map(
        db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(inArray(teams.id, ids))
          .all()
          .map((t) => [t.id, t.name] as const),
      )
    : new Map<number, string>();
  const sorted = ids
    .map((id) => ({ id, ...table.get(id)! }))
    .sort((x, y) => y.points - x.points || y.gd - x.gd);
  const tableOut = sorted.map((t, i) => ({
    rank: i + 1,
    team: names.get(t.id) ?? `#${t.id}`,
    played: t.played,
    points: t.points,
    gd: t.gd,
  }));
  const rankOf = (id: number) => {
    const i = sorted.findIndex((t) => t.id === id);
    return i >= 0 ? i + 1 : null;
  };
  return standingsPayloadSchema.parse({
    table: tableOut.slice(0, 24),
    homeRank: rankOf(homeTeamId),
    awayRank: rankOf(awayTeamId),
    note: season ? `${season} 赛季，由本地赛果库实时计算` : "由本地赛果库实时计算",
  });
}
