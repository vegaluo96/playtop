import { eq } from "drizzle-orm";
import { db } from "../db";
import { matches, teams } from "../db/schema";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { aiRetrieveSoftData } from "../datasources/aiRetrieval";
import { aiRetrieveOddsBooks } from "../datasources/aiOdds";
import { fetchPolymarketOdds } from "../datasources/polymarket";
import { computeForm, computeH2h, computeStandings, computeTeamStats } from "../datasources/localStats";
import { fetchKickoffWeather, geocode } from "../datasources/openMeteo";
import { INTERNATIONAL_LEAGUE_CODE } from "../datasources/international";
import { getMatch, syncFixtures, transitionMatch } from "./matchesService";
import { sportteryOddsForMatch } from "./oddsSync";
import { insertSnapshot, latestSnapshots } from "./snapshots";
import { leagueById, teamNameById } from "./teamResolver";

export interface CollectSummary {
  collected: string[];
  failed: { kind: string; error: string }[];
  status: string;
}

/**
 * 全维度采集编排：每个维度独立 try/catch（单维失败只降完备度，不阻塞链路）。
 * 可反复执行——这正是"实时改版"的数据侧：每次执行追加新快照（内容未变则去重）。
 */
export async function collectMatch(
  matchId: number,
  opts: { force?: boolean; skipAi?: boolean } = {},
): Promise<CollectSummary> {
  const force = opts.force ?? false;
  const match = getMatch(matchId);
  const league = leagueById(match.leagueId);
  const homeName = teamNameById(match.homeTeamId);
  const awayName = teamNameById(match.awayTeamId);
  const collected: string[] = [];
  const failed: { kind: string; error: string }[] = [];
  const attempt = async (kind: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      collected.push(kind);
    } catch (e) {
      failed.push({ kind, error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (match.status === "scheduled") transitionMatch(matchId, "collecting");

  const dsCfg = getConfig("datasources");
  const teamAliases = (teamId: number): string[] => {
    const t = db.select().from(teams).where(eq(teams.id, teamId)).get();
    return t ? [t.name, ...(JSON.parse(t.aliases) as string[])] : [];
  };

  // 盘口：多源并行、各自独立成败（每家书商独立快照，引擎侧做共识与最优价）
  if (match.source === "csv") {
    await attempt("odds:csv", async () => {
      await syncFixtures(false, force);
    });
  } else if (dsCfg.sportteryEnabled) {
    await attempt("odds:竞彩", async () => {
      if (!(await sportteryOddsForMatch(match))) throw new Error("竞彩未覆盖本场");
    });
  }
  if (dsCfg.polymarketEnabled) {
    await attempt("odds:polymarket", async () => {
      const payload = await fetchPolymarketOdds({
        homeNames: teamAliases(match.homeTeamId),
        awayNames: teamAliases(match.awayTeamId),
        kickoffAt: match.kickoffAt,
      });
      if (!payload) throw new Error("Polymarket 未匹配到本场市场");
      insertSnapshot(matchId, "odds", "polymarket", payload);
    });
  }
  if ((match.source === "csv" ? dsCfg.aiOddsForCsvLeagues : true) && !opts.skipAi) {
    await attempt("odds:ai", async () => {
      const books = await aiRetrieveOddsBooks({
        leagueName: league?.name ?? "",
        homeName,
        awayName,
        kickoffAtIso: new Date(match.kickoffAt).toISOString(),
        round: match.round,
      });
      if (books.length === 0) throw new Error("AI 未检索到可信赔率");
      for (const b of books) insertSnapshot(matchId, "odds", "llm", b);
    });
  }

  // 本地历史库统计（确定性，零外部调用）
  await attempt("h2h", () => {
    insertSnapshot(matchId, "h2h", "local_stats", computeH2h(match.homeTeamId, match.awayTeamId));
  });
  await attempt("form", () => {
    insertSnapshot(matchId, "form", "local_stats", computeForm(match.homeTeamId, match.awayTeamId));
  });
  await attempt("team_stats", () => {
    insertSnapshot(
      matchId,
      "team_stats",
      "local_stats",
      computeTeamStats(match.leagueId, match.homeTeamId, match.awayTeamId),
    );
  });
  if (league?.code !== INTERNATIONAL_LEAGUE_CODE) {
    await attempt("standings", () => {
      insertSnapshot(
        matchId,
        "standings",
        "local_stats",
        computeStandings(match.leagueId, match.homeTeamId, match.awayTeamId),
      );
    });
  }

  // 场馆坐标（一次性）：比赛字段 → 主队主场缺省 → 地理编码
  await attempt("venue", async () => {
    let lat = match.venueLat;
    let lon = match.venueLon;
    let label = match.venue ?? "";
    if (lat === null || lon === null) {
      const homeTeam = db.select().from(teams).where(eq(teams.id, match.homeTeamId)).get();
      if (!match.neutral && homeTeam?.venueLat !== null && homeTeam?.venueLon !== null && homeTeam) {
        lat = homeTeam.venueLat;
        lon = homeTeam.venueLon;
        label = homeTeam.homeVenue ?? label;
      } else {
        const query = match.venue || `${homeName}`;
        const geo = await geocode(query);
        if (geo) {
          lat = geo.lat;
          lon = geo.lon;
          label = label || geo.label;
        }
      }
      if (lat !== null && lon !== null) {
        db.update(matches)
          .set({ venueLat: lat, venueLon: lon, updatedAt: now() })
          .where(eq(matches.id, matchId))
          .run();
      }
    }
    insertSnapshot(matchId, "venue", "open_meteo", {
      name: label,
      city: "",
      lat,
      lon,
      capacity: null,
    });
  });

  // 天气（需坐标，预报范围 16 天内）
  await attempt("weather", async () => {
    const fresh = getMatch(matchId);
    if (fresh.venueLat === null || fresh.venueLon === null) throw new Error("无场馆坐标，跳过天气");
    if (fresh.kickoffAt - now() > 16 * 86_400_000) throw new Error("开球时间超出预报范围");
    const weather = await fetchKickoffWeather(fresh.venueLat, fresh.venueLon, fresh.kickoffAt);
    if (!weather) throw new Error("open-meteo 无返回");
    insertSnapshot(matchId, "weather", "open_meteo", weather);
  });

  // AI 检索软维度（apiyi）
  if (dsCfg.aiRetrievalEnabled && !opts.skipAi) {
    await attempt("ai_soft", async () => {
      const result = await aiRetrieveSoftData({
        leagueName: league?.name ?? "",
        homeName,
        awayName,
        kickoffAtIso: new Date(match.kickoffAt).toISOString(),
        round: match.round,
      });
      if (result.injuries) insertSnapshot(matchId, "injuries", "llm", result.injuries);
      if (result.suspensions) insertSnapshot(matchId, "suspensions", "llm", result.suspensions);
      if (result.lineups) insertSnapshot(matchId, "lineups", "llm", result.lineups);
      if (result.coach) insertSnapshot(matchId, "coach", "llm", result.coach);
      if (result.referee) insertSnapshot(matchId, "referee", "llm", result.referee);
      if (result.softInfo) insertSnapshot(matchId, "soft_info", "llm", result.softInfo);
    });
  }

  // 数据齐备校验：有盘口/手动覆盖 → ready；临近开球仍无盘口 → 兜底强制 ready（引擎走无市场退化链）
  const latest = latestSnapshots(matchId);
  const fresh = getMatch(matchId);
  let status = fresh.status;
  if (fresh.status === "collecting") {
    const hasOdds = latest.has("odds") || latest.has("manual_override");
    const fallbackHours = getConfig("automation").readyWithoutOddsHours;
    const nearKickoff =
      fallbackHours > 0 && fresh.kickoffAt > now() && fresh.kickoffAt - now() < fallbackHours * 3_600_000;
    if (hasOdds || nearKickoff) {
      transitionMatch(matchId, "ready");
      status = "ready";
    }
  }
  return { collected, failed, status };
}
