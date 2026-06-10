import { db } from "../db";
import { teams, type matches } from "../db/schema";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { fetchSporttery, type SportteryMatch } from "../datasources/sporttery";
import { insertSnapshot } from "./snapshots";

/**
 * 非 CSV 赛事（世界杯/手动建赛）的盘口自动拉取：竞彩官方接口优先（确定性数据），
 * 进程内 10 分钟缓存——一次抓取覆盖全部场次，逐场匹配零额外请求。
 */

const TTL = 10 * 60_000;
let cache: { at: number; rows: SportteryMatch[] } | null = null;
let lastError: { at: number; msg: string } | null = null;

export async function getSportteryRows(force = false): Promise<SportteryMatch[]> {
  if (!force && cache && now() - cache.at < TTL) return cache.rows;
  if (!force && lastError && now() - lastError.at < TTL) {
    throw new Error(`竞彩接口冷却中（上次失败：${lastError.msg}）`);
  }
  try {
    const rows = await fetchSporttery();
    cache = { at: now(), rows };
    lastError = null;
    return rows;
  } catch (e) {
    lastError = { at: now(), msg: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

/** 查找型队名解析：只查不建（与 resolveTeam 的区别——匹配失败不污染队伍表） */
function findTeamId(name: string): number | null {
  for (const t of db.select().from(teams).all()) {
    if (t.name === name) return t.id;
    if ((JSON.parse(t.aliases) as string[]).includes(name)) return t.id;
  }
  return null;
}

/**
 * 尝试用竞彩数据为单场比赛落 odds 快照。
 * 匹配规则：两队 id 全等 + 开球时间 ±2 小时（接口无钟点时放宽到同一天）。
 * 返回 false 表示未命中（未启用/无该场/无赔率），调用方降级到 AI 检索。
 */
export async function sportteryOddsForMatch(match: typeof matches.$inferSelect): Promise<boolean> {
  if (!getConfig("datasources").sportteryEnabled) return false;
  const rows = await getSportteryRows();
  for (const r of rows) {
    if (!r.oneXTwo || !r.homeEn || !r.awayEn) continue;
    const tolerance = r.hasTime ? 2 * 3_600_000 : 24 * 3_600_000;
    if (Math.abs(r.kickoffAt - match.kickoffAt) > tolerance) continue;
    if (findTeamId(r.homeEn) !== match.homeTeamId || findTeamId(r.awayEn) !== match.awayTeamId) continue;
    insertSnapshot(match.id, "odds", "sporttery", {
      bookmaker: "中国竞彩（官方）",
      oneXTwo: r.oneXTwo,
      ou: [],
      ah: [],
      capturedAt: now(),
    });
    return true;
  }
  return false;
}
