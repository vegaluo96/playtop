import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import { matches, teams } from "../db/schema";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { aiRetrieveSoftData } from "../datasources/aiRetrieval";
import { aiRetrieveOddsBooks } from "../datasources/aiOdds";
import {
  apiFootballConfigured,
  fetchAfFixturesByDate,
  fetchAfInjuries,
  fetchAfLineups,
  fetchAfOdds,
  matchAfFixture,
  type AfFixture,
} from "../datasources/apiFootball";
import { fetchPolymarketOdds } from "../datasources/polymarket";
import {
  ESPN_LEAGUE_SLUG,
  fetchEspnRoster,
  fetchEspnScoreboard,
  fetchEspnSummaryLineups,
  matchEspnEvent,
  positionToRole,
  type EspnEvent,
} from "../datasources/espn";
import { normName } from "../datasources/polymarket";
import { fetchClubElo, fetchEloRatings, findRating } from "../datasources/externalRatings";
import { fetchManifoldOdds, fetchSmarketsOdds } from "../datasources/predictionMarkets";
import { UNDERSTAT_LEAGUE, fetchUnderstatXg, findTeamXg } from "../datasources/understat";
import { intlPlayerStats } from "../datasources/githubIntl";
import type { externalRatingsPayloadSchema, playerStatsPayloadSchema } from "../datasources/types";
import { computeForm, computeH2h, computeStandings, computeTeamStats } from "../datasources/localStats";
import { fetchKickoffWeather, geocode } from "../datasources/openMeteo";
import { INTERNATIONAL_LEAGUE_CODE } from "../datasources/international";
import { getMatch, syncFixtures, transitionMatch } from "./matchesService";
import { sportteryOddsForMatch } from "./oddsSync";
import { isSourceUsable, withSource } from "./sourceHealth";
import { insertSnapshot, latestSnapshots } from "./snapshots";
import { leagueById, teamNameById } from "./teamResolver";

/** ESPN scoreboard 的 dates 参数：UTC YYYYMMDD */
function espnDate(kickoffAt: number): string {
  return new Date(kickoffAt).toISOString().slice(0, 10).replace(/-/g, "");
}

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

  const matchRef = {
    homeNames: teamAliases(match.homeTeamId),
    awayNames: teamAliases(match.awayTeamId),
    kickoffAt: match.kickoffAt,
  };
  const isIntl = league?.code === INTERNATIONAL_LEAGUE_CODE || league?.code === "WC2026";

  // ESPN scoreboard 单次抓取、多任务共享（odds/名单/阵容都要用，避免同 URL 冷却冲突）
  const espnSlug = ESPN_LEAGUE_SLUG[league?.code ?? ""];
  const espnUsable = isSourceUsable("espn", dsCfg.espnEnabled) && !!espnSlug;
  let espnEventsP: Promise<EspnEvent[]> | null = null;
  const getEspnEvent = async (): Promise<EspnEvent | null> => {
    if (!espnUsable) return null;
    if (!espnEventsP) {
      espnEventsP = withSource("espn", () => fetchEspnScoreboard(espnSlug, espnDate(match.kickoffAt)));
    }
    return matchEspnEvent(await espnEventsP, matchRef);
  };

  // API-Football（付费主源）：按比赛日拉一次 fixtures、本场内存共享（odds/首发/伤停共用 fixtureId）
  const afUsable = apiFootballConfigured() && isSourceUsable("api_football", dsCfg.apiFootballEnabled);
  let afFixtureP: Promise<AfFixture | null> | null = null;
  const getAfFixture = async (): Promise<AfFixture | null> => {
    if (!afUsable) return null;
    if (!afFixtureP) {
      afFixtureP = withSource("api_football", async () => {
        const dateUtc = new Date(match.kickoffAt).toISOString().slice(0, 10);
        return matchAfFixture(await fetchAfFixturesByDate(dateUtc), matchRef);
      });
    }
    return afFixtureP;
  };

  // 盘口：多源真并发（生产环境被墙源会挂死等超时，串行一次采集可达数分钟——
  // 并发后墙钟时间 = 最慢一源；每源独立成败 + 健康门控记账）。
  const networkTasks: Promise<void>[] = [];
  if (afUsable) {
    networkTasks.push(
      attempt("odds:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx) throw new Error("API-Football 未匹配到本场");
        const books = await withSource("api_football", () => fetchAfOdds(fx.fixtureId, now()));
        if (books.length === 0) throw new Error("API-Football 本场暂无盘口");
        for (const b of books) insertSnapshot(matchId, "odds", "api_football", b);
      }),
    );
    networkTasks.push(
      attempt("lineups:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx) throw new Error("API-Football 未匹配到本场");
        const lineups = await withSource("api_football", () => fetchAfLineups(fx.fixtureId, fx.homeId));
        if (!lineups) throw new Error("首发未公布");
        insertSnapshot(matchId, "lineups", "api_football", lineups);
      }),
    );
    networkTasks.push(
      attempt("injuries:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx) throw new Error("API-Football 未匹配到本场");
        const injuries = await withSource("api_football", () => fetchAfInjuries(fx.fixtureId, fx.homeId, fx.awayId));
        if (!injuries) throw new Error("本场无伤停记录");
        insertSnapshot(matchId, "injuries", "api_football", injuries);
      }),
    );
  }
  if (match.source === "csv") {
    networkTasks.push(
      attempt("odds:csv", async () => {
        await withSource("football_data_couk", () => syncFixtures(false, force));
      }),
    );
  } else if (isSourceUsable("sporttery", dsCfg.sportteryEnabled)) {
    networkTasks.push(
      attempt("odds:竞彩", async () => {
        if (!(await withSource("sporttery", () => sportteryOddsForMatch(match)))) throw new Error("竞彩未覆盖本场");
      }),
    );
  }
  if (isSourceUsable("polymarket", dsCfg.polymarketEnabled)) {
    networkTasks.push(
      attempt("odds:polymarket", async () => {
        const payload = await withSource("polymarket", () => fetchPolymarketOdds(matchRef));
        if (!payload) throw new Error("Polymarket 未匹配到本场市场");
        insertSnapshot(matchId, "odds", "polymarket", payload);
      }),
    );
  }
  if (isSourceUsable("manifold", dsCfg.manifoldEnabled)) {
    networkTasks.push(
      attempt("odds:manifold", async () => {
        const payload = await withSource("manifold", () => fetchManifoldOdds(matchRef));
        if (!payload) throw new Error("Manifold 未匹配到本场市场");
        insertSnapshot(matchId, "odds", "manifold", payload);
      }),
    );
  }
  if (isSourceUsable("smarkets", dsCfg.smarketsEnabled)) {
    networkTasks.push(
      attempt("odds:smarkets", async () => {
        const payload = await withSource("smarkets", () => fetchSmarketsOdds(matchRef));
        if (!payload) throw new Error("Smarkets 未匹配到本场事件");
        insertSnapshot(matchId, "odds", "smarkets", payload);
      }),
    );
  }
  if (espnUsable) {
    networkTasks.push(
      attempt("odds:espn", async () => {
        const hit = await getEspnEvent();
        if (!hit?.odds) throw new Error("ESPN 本场无赔率");
        insertSnapshot(matchId, "odds", "espn", hit.odds);
      }),
    );
    // 官方首发阵容（公布后 confirmed=true，喂建模情境与研报；AI 阵容退为兜底）
    networkTasks.push(
      attempt("lineups:espn", async () => {
        const hit = await getEspnEvent();
        if (!hit?.eventId) throw new Error("ESPN 未匹配到本场事件");
        const lineups = await fetchEspnSummaryLineups(espnSlug, hit.eventId, force);
        if (!lineups) throw new Error("首发未公布");
        insertSnapshot(matchId, "lineups", "espn", { confirmed: true, home: lineups.home, away: lineups.away, note: "ESPN 官方首发" });
      }),
    );
  }
  // 有 API-Football 真源时 AI 检索盘口自动退场（省 token、可信度更高）
  if ((match.source === "csv" ? dsCfg.aiOddsForCsvLeagues : true) && !opts.skipAi && !afUsable) {
    networkTasks.push(
      attempt("odds:ai", async () => {
      const books = await aiRetrieveOddsBooks({
        leagueName: league?.name ?? "",
        homeName,
        awayName,
        kickoffAtIso: new Date(match.kickoffAt).toISOString(),
        round: match.round,
      });
      if (books.length === 0) throw new Error("AI 未检索到可信赔率");
        for (const b of books) insertSnapshot(matchId, "odds", "llm", b);
      }),
    );
  }

  // 外部评级：国家队 → eloratings.net；俱乐部 → ClubElo + Understat xG（展示/事实维度）
  networkTasks.push(
    attempt("external_ratings", async () => {
    const items: z.infer<typeof externalRatingsPayloadSchema>["items"] = [];
    if (isIntl && isSourceUsable("eloratings", dsCfg.eloRatingsEnabled)) {
      const rows = await withSource("eloratings", () => fetchEloRatings(force));
      for (const [side, names] of [["home", matchRef.homeNames], ["away", matchRef.awayNames]] as const) {
        const r = findRating(rows, names);
        if (r) items.push({ source: "eloratings.net", team: side, name: r.name, rating: r.rating, rank: r.rank });
      }
    }
    if (!isIntl && isSourceUsable("clubelo", dsCfg.clubEloEnabled)) {
      const rows = await withSource("clubelo", () =>
        fetchClubElo(new Date(now()).toISOString().slice(0, 10), force),
      );
      for (const [side, names] of [["home", matchRef.homeNames], ["away", matchRef.awayNames]] as const) {
        const r = findRating(rows, names);
        if (r) items.push({ source: "ClubElo", team: side, name: r.name, rating: Math.round(r.rating), rank: r.rank });
      }
    }
    if (!isIntl && isSourceUsable("understat", dsCfg.understatEnabled) && UNDERSTAT_LEAGUE[league?.code ?? ""]) {
      const rows = await withSource("understat", () => fetchUnderstatXg(league!.code!, force));
      for (const [side, names] of [["home", matchRef.homeNames], ["away", matchRef.awayNames]] as const) {
        const r = findTeamXg(rows, names);
        if (r) {
          items.push({
            source: "Understat xG",
            team: side,
            name: r.name,
            rating: Number((r.xG / Math.max(1, r.matches)).toFixed(2)),
            note: `赛季 xG ${r.xG.toFixed(1)} / xGA ${r.xGA.toFixed(1)}（${r.matches} 场）`,
          });
        }
      }
    }
    if (items.length === 0) throw new Error("外部评级源无匹配数据");
    insertSnapshot(matchId, "external_ratings", isIntl ? "eloratings" : "clubelo", { items });
    }),
  );

  // 球员数据：ESPN 大名单（位置/号码/年龄，国家队+俱乐部通用）
  // 国际赛叠加真实射手榜/点球主罚/点球大战史（martj42）
  networkTasks.push(
    attempt("player_stats", async () => {
      type PsItem = z.infer<typeof playerStatsPayloadSchema>["items"][number];
      const items: PsItem[] = [];
      let fromEspn = false;
      let notes: string[] | undefined;
      const scorers = isIntl && isSourceUsable("github", dsCfg.githubIntlEnabled)
        ? await withSource("github", () => intlPlayerStats(homeName, awayName, force)).catch(() => null)
        : null;
      const ev = espnUsable ? await getEspnEvent().catch(() => null) : null;
      if (ev?.homeTeamId && ev.awayTeamId) {
        for (const [side, teamId] of [["home", ev.homeTeamId], ["away", ev.awayTeamId]] as const) {
          const roster = await fetchEspnRoster(espnSlug, teamId, force).catch(() => []);
          for (const p of roster.slice(0, 26)) {
            // 名单叠加真实射手数据（按归一化名匹配）
            const hit = scorers?.items.find((s) => s.team === side && normName(s.player) === normName(p.name));
            items.push({
              team: side,
              player: p.name,
              role: positionToRole(p.position),
              ...(hit?.goals !== undefined ? { goals: hit.goals } : {}),
              note: [p.jersey ? `${p.jersey} 号` : null, p.age ? `${p.age} 岁` : null, hit?.note ?? null]
                .filter(Boolean)
                .join("·"),
            });
          }
        }
      }
      if (items.length > 0) fromEspn = true;
      if (items.length === 0 && scorers) {
        items.push(...scorers.items); // ESPN 名单不可用时退回射手榜
      }
      notes = scorers?.notes;
      if (items.length === 0 && (notes?.length ?? 0) === 0) throw new Error("球员数据源均无记录");
      insertSnapshot(matchId, "player_stats", fromEspn ? "espn" : "github", {
        items,
        ...(notes ? { notes } : {}),
      });
    }),
  );

  // 等全部网络源并发完成（墙钟时间 = 最慢一源，而非求和）
  await Promise.all(networkTasks);

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
      // 官方源（ESPN / API-Football）优先：已有官方数据的维度，AI 检索不再覆盖
      const OFFICIAL = ["espn", "api_football"];
      const latestKind = (kind: "injuries" | "lineups") => latestSnapshots(matchId).get(kind);
      if (result.injuries && !OFFICIAL.includes(latestKind("injuries")?.source ?? "")) {
        insertSnapshot(matchId, "injuries", "llm", result.injuries);
      }
      if (result.suspensions) insertSnapshot(matchId, "suspensions", "llm", result.suspensions);
      if (result.lineups && !OFFICIAL.includes(latestKind("lineups")?.source ?? "")) {
        insertSnapshot(matchId, "lineups", "llm", result.lineups);
      }
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
