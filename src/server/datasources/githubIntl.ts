import { politeFetchText, parseCsv } from "./httpCache";
import { now } from "../lib/time";
import type { z } from "zod";
import type { playerStatsPayloadSchema } from "./types";

/**
 * martj42 国际赛数据集（GitHub raw，零 key，已实测）：
 * - goalscorers.csv：1916 至今全部进球（射手/分钟/点球/乌龙）→ 两队近年射手榜 + 点球主罚
 * - shootouts.csv：点球大战史 → 球队点球大战战绩事实
 */

const BASE = "https://raw.githubusercontent.com/martj42/international_results/master";

export interface ScorerRow {
  date: string;
  team: string;
  scorer: string;
  penalty: boolean;
  ownGoal: boolean;
}

export interface ShootoutRow {
  date: string;
  home: string;
  away: string;
  winner: string;
}

export function parseGoalscorers(text: string): ScorerRow[] {
  const { header, rows } = parseCsv(text);
  const idx = new Map(header.map((h, i) => [h, i] as const));
  const col = (r: string[], k: string) => r[idx.get(k) ?? -1] ?? "";
  return rows
    .map((r) => ({
      date: col(r, "date"),
      team: col(r, "team"),
      scorer: col(r, "scorer"),
      penalty: col(r, "penalty").toUpperCase() === "TRUE",
      ownGoal: col(r, "own_goal").toUpperCase() === "TRUE",
    }))
    .filter((r) => r.date && r.team && r.scorer);
}

export function parseShootouts(text: string): ShootoutRow[] {
  const { header, rows } = parseCsv(text);
  const idx = new Map(header.map((h, i) => [h, i] as const));
  const col = (r: string[], k: string) => r[idx.get(k) ?? -1] ?? "";
  return rows
    .map((r) => ({ date: col(r, "date"), home: col(r, "home_team"), away: col(r, "away_team"), winner: col(r, "winner") }))
    .filter((r) => r.date && r.winner);
}

type PlayerStatsPayload = z.infer<typeof playerStatsPayloadSchema>;

/** 两队近 sinceYears 年射手榜 Top5（标点球主罚）+ 点球大战史 notes（纯函数，可单测） */
export function buildIntlPlayerStats(
  scorers: ScorerRow[],
  shootouts: ShootoutRow[],
  homeTeam: string,
  awayTeam: string,
  refTime: number,
  sinceYears = 3,
): PlayerStatsPayload {
  const cutoff = new Date(refTime - sinceYears * 365 * 86_400_000).toISOString().slice(0, 10);
  const items: PlayerStatsPayload["items"] = [];
  for (const [team, side] of [
    [homeTeam, "home"],
    [awayTeam, "away"],
  ] as const) {
    const byPlayer = new Map<string, { goals: number; pens: number }>();
    for (const r of scorers) {
      if (r.team !== team || r.ownGoal || r.date < cutoff) continue;
      const cur = byPlayer.get(r.scorer) ?? { goals: 0, pens: 0 };
      cur.goals++;
      if (r.penalty) cur.pens++;
      byPlayer.set(r.scorer, cur);
    }
    [...byPlayer.entries()]
      .sort((a, b) => b[1].goals - a[1].goals)
      .slice(0, 5)
      .forEach(([player, s]) => {
        items.push({
          team: side,
          player,
          role: "attacker",
          goals: s.goals,
          note: `近${sinceYears}年国家队进球${s.goals}个${s.pens > 0 ? `（含点球${s.pens}）` : ""}`,
        });
      });
  }
  const notes: string[] = [];
  for (const team of [homeTeam, awayTeam]) {
    const games = shootouts.filter((s) => s.home === team || s.away === team);
    if (games.length > 0) {
      const wins = games.filter((s) => s.winner === team).length;
      notes.push(`${team} 历史点球大战 ${games.length} 次，胜 ${wins} 次`);
    }
  }
  const direct = shootouts.filter(
    (s) => (s.home === homeTeam && s.away === awayTeam) || (s.home === awayTeam && s.away === homeTeam),
  );
  for (const d of direct) notes.push(`两队曾于 ${d.date} 点球大战，${d.winner} 胜出`);
  return { items, notes };
}

/** 进程内缓存（数据集 ~5MB，12 小时刷新一次足够） */
let cache: { at: number; scorers: ScorerRow[]; shootouts: ShootoutRow[] } | null = null;
const TTL = 12 * 3_600_000;

export async function intlPlayerStats(homeTeam: string, awayTeam: string, force = false): Promise<PlayerStatsPayload> {
  if (force || !cache || now() - cache.at > TTL) {
    const gs = await politeFetchText(`${BASE}/goalscorers.csv`, force);
    const so = await politeFetchText(`${BASE}/shootouts.csv`, force);
    cache = { at: now(), scorers: parseGoalscorers(gs.body), shootouts: parseShootouts(so.body) };
  }
  return buildIntlPlayerStats(cache.scorers, cache.shootouts, homeTeam, awayTeam, now());
}
