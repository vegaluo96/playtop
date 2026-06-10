import { db } from "../db";
import { historyMatches } from "../db/schema";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { fetchLeagueSeasonCsv, seasonCodes } from "../datasources/footballDataCouk";
import { fetchInternationalResults, INTERNATIONAL_LEAGUE_CODE } from "../datasources/international";
import { ensureLeague, LEAGUE_NAMES, resolveTeam } from "./teamResolver";

/**
 * 历史赛果导入：模型的训练底座。
 * - 俱乐部联赛：football-data.co.uk 多季 CSV（含收盘赔率与射门统计）
 * - 国家队：martj42/international_results（世界杯等国际大赛用）
 * dedup_key 保证幂等，可反复执行增量更新。
 */

export interface ImportSummary {
  league: string;
  season: string;
  inserted: number;
  skipped: number;
}

function insertHistoryRow(row: {
  leagueId: number;
  season: string;
  playedAt: number;
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  htHome?: number | null;
  htAway?: number | null;
  neutral?: boolean;
  stats?: unknown;
  closingOdds?: unknown;
  referee?: string | null;
  dedupKey: string;
}): boolean {
  try {
    db.insert(historyMatches)
      .values({
        leagueId: row.leagueId,
        season: row.season,
        playedAt: row.playedAt,
        homeTeamId: row.homeTeamId,
        awayTeamId: row.awayTeamId,
        homeGoals: row.homeGoals,
        awayGoals: row.awayGoals,
        htHome: row.htHome ?? null,
        htAway: row.htAway ?? null,
        neutral: row.neutral ? 1 : 0,
        stats: row.stats ? JSON.stringify(row.stats) : null,
        closingOdds: row.closingOdds ? JSON.stringify(row.closingOdds) : null,
        referee: row.referee ?? null,
        dedupKey: row.dedupKey,
        createdAt: now(),
      })
      .run();
    return true;
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) return false;
    throw e;
  }
}

export async function importLeagueHistory(
  leagueCode: string,
  seasons = 3,
  force = false,
): Promise<ImportSummary[]> {
  const cfg = getConfig("datasources");
  const leagueId = ensureLeague(leagueCode);
  const country = LEAGUE_NAMES[leagueCode]?.country ?? null;
  const out: ImportSummary[] = [];
  for (const season of seasonCodes(now(), seasons)) {
    let rows;
    try {
      ({ rows } = await fetchLeagueSeasonCsv(cfg.csvBase, leagueCode, season, force));
    } catch (e) {
      out.push({ league: leagueCode, season, inserted: 0, skipped: -1 });
      console.warn(`[import] ${leagueCode}/${season} 抓取失败：${e instanceof Error ? e.message : e}`);
      continue;
    }
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const homeId = resolveTeam(r.homeTeam, country);
      const awayId = resolveTeam(r.awayTeam, country);
      const ok = insertHistoryRow({
        leagueId,
        season,
        playedAt: r.playedAt,
        homeTeamId: homeId,
        awayTeamId: awayId,
        homeGoals: r.fthg,
        awayGoals: r.ftag,
        htHome: r.hthg,
        htAway: r.htag,
        stats: {
          homeShots: r.homeShots,
          awayShots: r.awayShots,
          homeSot: r.homeSot,
          awaySot: r.awaySot,
          homeCorners: r.homeCorners,
          awayCorners: r.awayCorners,
        },
        closingOdds: r.odds,
        referee: r.referee,
        dedupKey: `${leagueCode}|${new Date(r.playedAt).toISOString().slice(0, 10)}|${r.homeTeam}|${r.awayTeam}`,
      });
      if (ok) inserted++;
      else skipped++;
    }
    out.push({ league: leagueCode, season, inserted, skipped });
  }
  return out;
}

export async function importInternationalHistory(sinceYear: number, force = false): Promise<ImportSummary> {
  const leagueId = ensureLeague(INTERNATIONAL_LEAGUE_CODE);
  const { rows } = await fetchInternationalResults(sinceYear, force);
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const homeId = resolveTeam(r.homeTeam, "国际");
    const awayId = resolveTeam(r.awayTeam, "国际");
    const ok = insertHistoryRow({
      leagueId,
      season: new Date(r.playedAt).getUTCFullYear().toString(),
      playedAt: r.playedAt,
      homeTeamId: homeId,
      awayTeamId: awayId,
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals,
      neutral: r.neutral,
      stats: { tournament: r.tournament },
      dedupKey: `INT|${new Date(r.playedAt).toISOString().slice(0, 10)}|${r.homeTeam}|${r.awayTeam}`,
    });
    if (ok) inserted++;
    else skipped++;
  }
  return { league: INTERNATIONAL_LEAGUE_CODE, season: `${sinceYear}+`, inserted, skipped };
}
