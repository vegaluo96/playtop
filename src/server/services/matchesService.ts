import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "../db";
import { matches, type MatchStatus } from "../db/schema";
import { HttpError } from "../lib/api";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { csvExtId, fetchFixturesCsv } from "../datasources/footballDataCouk";
import { insertSnapshot } from "./snapshots";
import { addTeamAlias, ensureLeague, LEAGUE_NAMES, resolveTeam } from "./teamResolver";

/** 状态机合法迁移表——所有状态变化必须经 transitionMatch */
const TRANSITIONS: Record<MatchStatus, MatchStatus[]> = {
  scheduled: ["collecting", "void"],
  collecting: ["ready", "collecting", "void"],
  ready: ["analyzed", "collecting", "void"],
  analyzed: ["published", "collecting", "void"],
  published: ["in_play", "void"],
  in_play: ["finished", "void"],
  finished: ["settled", "void"],
  settled: [],
  void: [],
};

export function transitionMatch(matchId: number, to: MatchStatus): void {
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new HttpError(404, "比赛不存在");
  if (match.status === to) return;
  if (!TRANSITIONS[match.status].includes(to)) {
    throw new HttpError(400, `非法状态迁移：${match.status} → ${to}`);
  }
  db.update(matches).set({ status: to, updatedAt: now() }).where(eq(matches.id, matchId)).run();
}

export interface FixtureSyncResult {
  created: number;
  oddsUpdated: number;
  skipped: number;
}

/**
 * 从 fixtures.csv 同步：createNew=true 时导入新赛程；
 * 对已存在且未开赛的比赛追加最新 odds 快照（构成盘口异动序列）。
 */
export async function syncFixtures(createNew: boolean, force = false): Promise<FixtureSyncResult> {
  const cfg = getConfig("datasources");
  const { rows } = await fetchFixturesCsv(cfg.csvBase, cfg.enabledLeagues, force);
  let created = 0;
  let oddsUpdated = 0;
  let skipped = 0;
  const preKickoff: MatchStatus[] = ["scheduled", "collecting", "ready", "analyzed", "published"];
  for (const r of rows) {
    if (r.kickoffAt < now() - 6 * 3_600_000) continue;
    const extId = csvExtId(r.div, r.kickoffAt, r.homeTeam, r.awayTeam);
    let match = db.select().from(matches).where(eq(matches.extId, extId)).get();
    if (!match && createNew) {
      const leagueId = ensureLeague(r.div);
      const country = LEAGUE_NAMES[r.div]?.country ?? null;
      const homeId = resolveTeam(r.homeTeam, country);
      const awayId = resolveTeam(r.awayTeam, country);
      addTeamAlias(homeId, r.homeTeam);
      addTeamAlias(awayId, r.awayTeam);
      match = db
        .insert(matches)
        .values({
          extId,
          leagueId,
          homeTeamId: homeId,
          awayTeamId: awayId,
          kickoffAt: r.kickoffAt,
          source: "csv",
          status: "scheduled",
          createdAt: now(),
          updatedAt: now(),
        })
        .returning()
        .get();
      created++;
    }
    if (!match) {
      skipped++;
      continue;
    }
    if (preKickoff.includes(match.status) && r.odds.home && r.odds.draw && r.odds.away) {
      const payload = {
        bookmaker: "football-data.co.uk 综合",
        oneXTwo: { home: r.odds.home, draw: r.odds.draw, away: r.odds.away },
        ou:
          r.odds.over25 && r.odds.under25
            ? [{ line: 2.5, over: r.odds.over25, under: r.odds.under25 }]
            : [],
        ah:
          r.odds.ahLine !== null && r.odds.ahHome && r.odds.ahAway
            ? [{ line: r.odds.ahLine, home: r.odds.ahHome, away: r.odds.ahAway }]
            : [],
        capturedAt: now(),
      };
      const { changed } = insertSnapshot(match.id, "odds", "football_data_couk", payload);
      if (changed) oddsUpdated++;
    }
  }
  return { created, oddsUpdated, skipped };
}

export function createManualMatch(input: {
  leagueCode: string;
  homeName: string;
  awayName: string;
  kickoffAt: number;
  venue?: string;
  neutral?: boolean;
  round?: string;
  country?: string;
}): number {
  const leagueId = ensureLeague(input.leagueCode);
  const country = input.country ?? LEAGUE_NAMES[input.leagueCode]?.country ?? null;
  const homeId = resolveTeam(input.homeName, country);
  const awayId = resolveTeam(input.awayName, country);
  const inserted = db
    .insert(matches)
    .values({
      leagueId,
      homeTeamId: homeId,
      awayTeamId: awayId,
      kickoffAt: input.kickoffAt,
      venue: input.venue ?? null,
      neutral: input.neutral ? 1 : 0,
      round: input.round ?? null,
      source: "manual",
      status: "scheduled",
      createdAt: now(),
      updatedAt: now(),
    })
    .returning({ id: matches.id })
    .get();
  return inserted.id;
}

export function getMatch(matchId: number) {
  const m = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!m) throw new HttpError(404, "比赛不存在");
  return m;
}

/** cron：把已到开球时间的 published 比赛找出来（锁定终版用） */
export function matchesAtKickoff() {
  return db
    .select()
    .from(matches)
    .where(and(eq(matches.status, "published"), lte(matches.kickoffAt, now())))
    .all();
}

export function matchesByStatus(statuses: MatchStatus[]) {
  return db.select().from(matches).where(inArray(matches.status, statuses)).all();
}
