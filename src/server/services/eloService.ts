import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { historyMatches, teamRatings } from "../db/schema";
import { updateElo } from "../engine/elo";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";

/**
 * Elo 评分维护：按时间序回放历史赛果建立基线（脚本/导入后调用），
 * 结算时增量更新。当前值存 team_ratings。
 */

export function getRating(teamId: number): { rating: number; matchesPlayed: number } {
  const row = db.select().from(teamRatings).where(eq(teamRatings.teamId, teamId)).get();
  return row ? { rating: row.elo, matchesPlayed: row.matchesPlayed } : { rating: 1500, matchesPlayed: 0 };
}

function setRating(teamId: number, rating: number, matchesPlayed: number): void {
  db.insert(teamRatings)
    .values({ teamId, elo: rating, matchesPlayed, updatedAt: now() })
    .onConflictDoUpdate({
      target: teamRatings.teamId,
      set: { elo: rating, matchesPlayed, updatedAt: now() },
    })
    .run();
}

export function applyMatchToElo(input: {
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  neutral: boolean;
}): void {
  const cfg = getConfig("engine");
  const home = getRating(input.homeTeamId);
  const away = getRating(input.awayTeamId);
  const updated = updateElo(home.rating, away.rating, input.homeGoals, input.awayGoals, {
    k0: cfg.eloK0,
    goalDiffExp: cfg.eloGoalDiffExp,
    homeAdv: input.neutral ? 0 : cfg.homeAdvElo,
  });
  setRating(input.homeTeamId, updated.home, home.matchesPlayed + 1);
  setRating(input.awayTeamId, updated.away, away.matchesPlayed + 1);
}

/** 全量重放：清空评分 → 按时间序回放 history_matches。返回回放场次 */
export function backfillElo(): number {
  db.delete(teamRatings).run();
  const rows = db.select().from(historyMatches).orderBy(asc(historyMatches.playedAt)).all();
  // 进程内累积，最后落库（几万场逐行 upsert 太慢）
  const ratings = new Map<number, { rating: number; matchesPlayed: number }>();
  const cfg = getConfig("engine");
  const get = (id: number) => ratings.get(id) ?? { rating: 1500, matchesPlayed: 0 };
  for (const r of rows) {
    const home = get(r.homeTeamId);
    const away = get(r.awayTeamId);
    const updated = updateElo(home.rating, away.rating, r.homeGoals, r.awayGoals, {
      k0: cfg.eloK0,
      goalDiffExp: cfg.eloGoalDiffExp,
      homeAdv: r.neutral ? 0 : cfg.homeAdvElo,
    });
    ratings.set(r.homeTeamId, { rating: updated.home, matchesPlayed: home.matchesPlayed + 1 });
    ratings.set(r.awayTeamId, { rating: updated.away, matchesPlayed: away.matchesPlayed + 1 });
  }
  db.transaction(() => {
    for (const [teamId, v] of ratings) setRating(teamId, v.rating, v.matchesPlayed);
  });
  return rows.length;
}
