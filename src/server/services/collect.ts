import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import { matches, teams } from "../db/schema";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { aiRetrieveSoftData } from "../datasources/aiRetrieval";
import {
  apiFootballConfigured,
  fetchAfFixturesByDate,
  fetchAfInjuries,
  fetchAfLineups,
  fetchAfOdds,
  fetchAfSquad,
  fetchAfStandings,
  matchAfFixture,
  type AfFixture,
} from "../datasources/apiFootball";
import { fetchPolymarketOdds, normName } from "../datasources/polymarket";
import { fetchClubElo, fetchEloRatings, findRating } from "../datasources/externalRatings";
import { fetchSmarketsOdds } from "../datasources/predictionMarkets";
import { UNDERSTAT_LEAGUE, fetchUnderstatXg, findTeamXg } from "../datasources/understat";
import { intlPlayerStats } from "../datasources/githubIntl";
import type { externalRatingsPayloadSchema, playerStatsPayloadSchema } from "../datasources/types";
import { computeForm, computeH2h, computeStandings, computeTeamStats } from "../datasources/localStats";
import { fetchKickoffWeather, geocode } from "../datasources/openMeteo";
import { INTERNATIONAL_LEAGUE_CODE } from "../datasources/international";
import { getMatch, syncFixtures, transitionMatch } from "./matchesService";
import { isSourceUsable, withSource } from "./sourceHealth";
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
  opts: { force?: boolean; skipAi?: boolean; oddsOnly?: boolean } = {},
): Promise<CollectSummary> {
  const force = opts.force ?? false;
  /** 临场加密刷新模式：只跑盘口+官方首发（价差监测的时效窗口），其余维度不动 */
  const oddsOnly = opts.oddsOnly ?? false;
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

  // ── 按维度新鲜度策略：一次性/慢变数据不重复调用（force 绕过）──────────────
  // 盘口永远实时;首发只在临场窗口尝试、确认后停;裁判拿到即停;
  // 名单 24h、积分榜 12h、伤停 6h、外部评级 24h、天气 3h。
  const pre = latestSnapshots(matchId);
  const ageOf = (kind: Parameters<typeof pre.get>[0]): number => {
    const r = pre.get(kind);
    return r ? now() - r.fetchedAt : Infinity;
  };
  const H = 3_600_000;

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
    if (force || (pre.get("lineups")?.source !== "api_football" && match.kickoffAt - now() < 3 * H)) networkTasks.push(
      attempt("lineups:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx) throw new Error("API-Football 未匹配到本场");
        const lineups = await withSource("api_football", () => fetchAfLineups(fx.fixtureId, fx.homeId));
        if (!lineups) throw new Error("首发未公布");
        insertSnapshot(matchId, "lineups", "api_football", lineups);
      }),
    );
    if (!oddsOnly && (force || pre.get("injuries")?.source !== "api_football" || ageOf("injuries") >= 6 * H)) networkTasks.push(
      attempt("injuries:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx) throw new Error("API-Football 未匹配到本场");
        const injuries = await withSource("api_football", () => fetchAfInjuries(fx.fixtureId, fx.homeId, fx.awayId));
        if (!injuries) throw new Error("本场无伤停记录");
        insertSnapshot(matchId, "injuries", "api_football", injuries);
      }),
    );
    if (!oddsOnly && (force || pre.get("referee")?.source !== "api_football")) networkTasks.push(
      attempt("referee:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx?.referee) throw new Error("裁判未公布");
        insertSnapshot(matchId, "referee", "api_football", { name: fx.referee, note: "" });
      }),
    );
    if (!oddsOnly && (force || pre.get("standings")?.source !== "api_football" || ageOf("standings") >= 12 * H)) networkTasks.push(
      attempt("standings:api_football", async () => {
        const fx = await getAfFixture();
        if (!fx?.leagueId || !fx.season) throw new Error("API-Football 未匹配到本场");
        const rows = await withSource("api_football", () => fetchAfStandings(fx.leagueId!, fx.season!));
        if (rows.length === 0) throw new Error("本赛事暂无积分榜");
        // 世界杯等分组赛事：只取双方所在组，联赛取全表（防止 48 队全量刷屏）
        const myGroups = new Set(rows.filter((r) => r.teamId === fx.homeId || r.teamId === fx.awayId).map((r) => r.group));
        const table = rows.filter((r) => myGroups.size === 0 || myGroups.has(r.group)).slice(0, 24);
        insertSnapshot(matchId, "standings", "api_football", {
          table: table.map((r) => ({ rank: r.rank, team: r.team, played: r.played, points: r.points, gd: r.gd })),
          homeRank: rows.find((r) => r.teamId === fx.homeId)?.rank ?? null,
          awayRank: rows.find((r) => r.teamId === fx.awayId)?.rank ?? null,
          ...(myGroups.size > 0 && [...myGroups][0] ? { note: [...myGroups].filter(Boolean).join(" / ") } : {}),
        });
      }),
    );
  }
  if (match.source === "csv") {
    networkTasks.push(
      attempt("odds:csv", async () => {
        await withSource("football_data_couk", () => syncFixtures(false, force));
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
  if (isSourceUsable("smarkets", dsCfg.smarketsEnabled)) {
    networkTasks.push(
      attempt("odds:smarkets", async () => {
        const payload = await withSource("smarkets", () => fetchSmarketsOdds(matchRef));
        if (!payload) throw new Error("Smarkets 未匹配到本场事件");
        insertSnapshot(matchId, "odds", "smarkets", payload);
      }),
    );
  }

  // 外部评级：国家队 → eloratings.net；俱乐部 → ClubElo + Understat xG（展示/事实维度）
  if (!oddsOnly && (force || ageOf("external_ratings") >= 24 * H)) networkTasks.push(
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

  // 球员数据：API-Football 球队名单（位置/号码/年龄）；国际赛叠加真实射手榜/点球史（martj42）
  if (!oddsOnly && (force || ageOf("player_stats") >= 24 * H)) networkTasks.push(
    attempt("player_stats", async () => {
      type PsItem = z.infer<typeof playerStatsPayloadSchema>["items"][number];
      const items: PsItem[] = [];
      const scorers = isIntl && isSourceUsable("github", dsCfg.githubIntlEnabled)
        ? await withSource("github", () => intlPlayerStats(homeName, awayName, force)).catch(() => null)
        : null;
      const fx = afUsable ? await getAfFixture().catch(() => null) : null;
      let fromAf = false;
      if (fx) {
        for (const [side, teamId] of [["home", fx.homeId], ["away", fx.awayId]] as const) {
          const squad = await withSource("api_football", () => fetchAfSquad(teamId)).catch(() => []);
          for (const pl of squad.slice(0, 26)) {
            // 名单叠加真实射手数据（按归一化名匹配）
            const hit = scorers?.items.find((s) => s.team === side && normName(s.player) === normName(pl.name));
            items.push({
              team: side,
              player: pl.name,
              role: pl.role,
              ...(hit?.goals !== undefined ? { goals: hit.goals } : {}),
              note: [pl.number ? `${pl.number} 号` : null, pl.age ? `${pl.age} 岁` : null, hit?.note ?? null]
                .filter(Boolean)
                .join("·"),
            });
          }
        }
        if (items.length > 0) fromAf = true;
      }
      if (items.length === 0 && scorers) items.push(...scorers.items); // 名单不可用时退回射手榜
      const notes = scorers?.notes;
      if (items.length === 0 && (notes?.length ?? 0) === 0) throw new Error("球员数据源均无记录");
      insertSnapshot(matchId, "player_stats", fromAf ? "api_football" : "github", {
        items,
        ...(notes ? { notes } : {}),
      });
    }),
  );

  // 等全部网络源并发完成（墙钟时间 = 最慢一源，而非求和）
  await Promise.all(networkTasks);

  // 本地历史库统计（确定性，零外部调用）
  if (!oddsOnly) await attempt("h2h", () => {
    insertSnapshot(matchId, "h2h", "local_stats", computeH2h(match.homeTeamId, match.awayTeamId));
  });
  if (!oddsOnly) await attempt("form", () => {
    insertSnapshot(matchId, "form", "local_stats", computeForm(match.homeTeamId, match.awayTeamId));
  });
  if (!oddsOnly) await attempt("team_stats", () => {
    insertSnapshot(
      matchId,
      "team_stats",
      "local_stats",
      computeTeamStats(match.leagueId, match.homeTeamId, match.awayTeamId),
    );
  });
  if (!oddsOnly && league?.code !== INTERNATIONAL_LEAGUE_CODE && latestSnapshots(matchId).get("standings")?.source !== "api_football") {
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
  if (!oddsOnly) await attempt("venue", async () => {
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

  // 天气（需坐标，预报范围 16 天内）：3h TTL，临场仍能反映突变
  if (!oddsOnly && (force || ageOf("weather") >= 3 * H)) await attempt("weather", async () => {
    const fresh = getMatch(matchId);
    if (fresh.venueLat === null || fresh.venueLon === null) throw new Error("无场馆坐标，跳过天气");
    if (fresh.kickoffAt - now() > 16 * 86_400_000) throw new Error("开球时间超出预报范围");
    const weather = await fetchKickoffWeather(fresh.venueLat, fresh.venueLon, fresh.kickoffAt);
    if (!weather) throw new Error("open-meteo 无返回");
    insertSnapshot(matchId, "weather", "open_meteo", weather);
  });

  // AI 检索软维度（apiyi）
  if (!oddsOnly && dsCfg.aiRetrievalEnabled && !opts.skipAi) {
    await attempt("ai_soft", async () => {
      const result = await aiRetrieveSoftData({
        leagueName: league?.name ?? "",
        homeName,
        awayName,
        kickoffAtIso: new Date(match.kickoffAt).toISOString(),
        round: match.round,
      });
      // 官方源（API-Football）优先：已有官方数据的维度，AI 检索不再覆盖
      const OFFICIAL = ["api_football"];
      const latestKind = (kind: "injuries" | "lineups") => latestSnapshots(matchId).get(kind);
      if (result.injuries && !OFFICIAL.includes(latestKind("injuries")?.source ?? "")) {
        insertSnapshot(matchId, "injuries", "llm", result.injuries);
      }
      if (result.suspensions) insertSnapshot(matchId, "suspensions", "llm", result.suspensions);
      if (result.lineups && !OFFICIAL.includes(latestKind("lineups")?.source ?? "")) {
        insertSnapshot(matchId, "lineups", "llm", result.lineups);
      }
      if (result.coach) insertSnapshot(matchId, "coach", "llm", result.coach);
      if (result.referee && !OFFICIAL.includes(latestSnapshots(matchId).get("referee")?.source ?? "")) {
        insertSnapshot(matchId, "referee", "llm", result.referee);
      }
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
