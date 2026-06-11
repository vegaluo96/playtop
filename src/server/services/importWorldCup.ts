import { eq } from "drizzle-orm";
import { db } from "../db";
import { matches } from "../db/schema";
import { now } from "../lib/time";
import {
  WC_LEAGUE_CODE,
  WC_TEAM_FIX,
  fetchWorldCupFixtures,
  wcNeutral,
  wcRoundCn,
} from "../datasources/openfootballWorldCup";
import { addTeamAlias, ensureLeague, resolveTeam } from "./teamResolver";

export interface WcImportResult {
  created: number;
  updated: number;
  unchanged: number;
  /** 淘汰赛占位（对阵未定）——确定后由定时同步自动补建 */
  pendingKnockout: number;
  pastSkipped: number;
}

/**
 * 世界杯 2026 一键导入/增量同步（幂等，可反复执行）：
 * - 队名自动映射到 martj42 历史库口径（h2h/近况本地统计直接接上历史数据）
 * - 中立场、场馆城市（喂天气地理编码）、UTC 开球时间自动处理
 * - 已存在场次仅在开球时间/场馆变化时更新；淘汰赛对阵确定后自动建赛
 */
export async function importWorldCupFixtures(force = false): Promise<WcImportResult> {
  const { fixtures } = await fetchWorldCupFixtures(force);
  const leagueId = ensureLeague(WC_LEAGUE_CODE);
  const r: WcImportResult = { created: 0, updated: 0, unchanged: 0, pendingKnockout: 0, pastSkipped: 0 };
  for (const f of fixtures) {
    if (f.pending) {
      r.pendingKnockout++;
      continue;
    }
    if (f.kickoffAt < now() - 6 * 3_600_000) {
      r.pastSkipped++;
      continue;
    }
    const home = WC_TEAM_FIX[f.homeTeam] ?? f.homeTeam;
    const away = WC_TEAM_FIX[f.awayTeam] ?? f.awayTeam;
    // 淘汰赛用官方场次编号做稳定外键（改期不丢）；小组赛用 日期|对阵
    const extId =
      f.matchNo !== null
        ? `${WC_LEAGUE_CODE}|M${f.matchNo}`
        : `${WC_LEAGUE_CODE}|${new Date(f.kickoffAt).toISOString().slice(0, 10)}|${home}|${away}`;
    const existing = db.select().from(matches).where(eq(matches.extId, extId)).get();
    if (existing) {
      if (existing.kickoffAt !== f.kickoffAt || existing.venue !== f.city) {
        db.update(matches)
          .set({ kickoffAt: f.kickoffAt, venue: f.city, updatedAt: now() })
          .where(eq(matches.id, existing.id))
          .run();
        r.updated++;
      } else r.unchanged++;
      continue;
    }
    const homeId = resolveTeam(home, "国际");
    const awayId = resolveTeam(away, "国际");
    if (home !== f.homeTeam) addTeamAlias(homeId, f.homeTeam);
    if (away !== f.awayTeam) addTeamAlias(awayId, f.awayTeam);
    db.insert(matches)
      .values({
        extId,
        leagueId,
        homeTeamId: homeId,
        awayTeamId: awayId,
        kickoffAt: f.kickoffAt,
        venue: f.city,
        neutral: wcNeutral(home, f.city) ? 1 : 0,
        round: wcRoundCn(f.round),
        source: "openfootball",
        status: "scheduled",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    r.created++;
  }
  return r;
}
