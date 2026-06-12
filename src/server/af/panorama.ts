/**
 * matchPanorama(fixtureId):详情页/AI 报告的一次性拼装层。
 * 核心 = /fixtures?id=(单请求带回 events/lineups/statistics/players)
 *      + 平台快照库(odds 走势/百家/异动、predictions)
 *      + 低频维度(伤停/榜单/教练/转会/荣誉/球队名单,kv 缓存)。
 * 滚球与 T-30min 内 force=true 绕 client 缓存;其余沿用缓存与 kv TTL。
 */
import { afGet } from "./client";
import { runAfEndpoint } from "./catalog";
import { mustForce, isLive } from "./schedule";
import {
  fixtureById,
  kvCached,
  latestPrediction,
  movementsOf,
  oddsCompare,
  oddsSeries,
  upsertFixture,
  type FixtureRow,
  type MovementRow,
  type SnapRow,
} from "./store";

const H = 3_600_000;

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

export interface Panorama {
  fixture: FixtureRow;
  /** /fixtures?id= 的完整 payload(events/lineups/statistics/players 内嵌) */
  bundle: Record<string, unknown>;
  odds: {
    ah: SnapRow[];
    ou: SnapRow[];
    eu: SnapRow[];
    compareAh: ReturnType<typeof oddsCompare>;
    compareOu: ReturnType<typeof oddsCompare>;
    compareEu: ReturnType<typeof oddsCompare>;
  };
  movements: MovementRow[];
  prediction: Record<string, unknown> | null;
  injuries: unknown[];
  deep: {
    topscorers: unknown[];
    topassists: unknown[];
    topyellow: unknown[];
    topred: unknown[];
    coachHome: unknown | null;
    coachAway: unknown | null;
    transfersHome: unknown[];
    transfersAway: unknown[];
    squadHome: unknown | null;
    squadAway: unknown | null;
    statsHome: unknown | null;
    statsAway: unknown | null;
    trophiesHomeCoach: unknown[];
    trophiesAwayCoach: unknown[];
  } | null;
}

/** 确保 fixtures_cache 里有带 events/lineups 的完整 bundle(必要时出网拉一枪) */
async function ensureBundle(fixtureId: number): Promise<FixtureRow | null> {
  let fx = fixtureById(fixtureId);
  const now = Date.now();
  const needFresh =
    !fx ||
    (() => {
      const hasEvents = fx!.payload.includes('"events"');
      const live = isLive(fx!.status);
      const stale = now - fx!.updated_at > (live ? 55_000 : mustForce(fx!.kickoff_utc, now, fx!.status) ? 50_000 : 10 * 60_000);
      return !hasEvents || stale;
    })();
  if (needFresh) {
    try {
      const force = !fx || mustForce(fx.kickoff_utc, now, fx.status) || isLive(fx?.status ?? "NS");
      const env = await afGet(`/fixtures?id=${fixtureId}`, { force });
      const raw = Array.isArray(env.response) ? env.response[0] : null;
      // 身份校验:防把别场的 bundle(阵容/事件)写到本场
      const item = raw && Number((raw as { fixture?: { id?: number } }).fixture?.id) === fixtureId ? raw : null;
      if (item) upsertFixture(item);
      fx = fixtureById(fixtureId);
    } catch {
      /* 离线/配额:退回缓存 */
    }
  }
  return fx;
}

async function loadDeep(fx: FixtureRow): Promise<Panorama["deep"]> {
  const { league_id: lg, season } = fx;
  const day = 24 * H, week = 7 * day;
  const list = async (key: string, ttl: number, ep: string, params: Record<string, string>) =>
    kvCached<unknown[]>(key, ttl, async () => {
      const r = await runAfEndpoint(ep, params);
      return Array.isArray(r.response) ? r.response : [];
    }).catch(() => [] as unknown[]);

  const [topscorers, topassists, topyellow, topred] = await Promise.all([
    list(`lg:${lg}:${season}:topscorers`, day, "players.topscorers", { league: String(lg), season: String(season) }),
    list(`lg:${lg}:${season}:topassists`, day, "players.topassists", { league: String(lg), season: String(season) }),
    list(`lg:${lg}:${season}:topyellow`, day, "players.topyellowcards", { league: String(lg), season: String(season) }),
    list(`lg:${lg}:${season}:topred`, day, "players.topredcards", { league: String(lg), season: String(season) }),
  ]);

  const teamBlock = async (teamId: number | null) => {
    if (!teamId) return { coach: null, transfers: [] as unknown[], squad: null, trophies: [] as unknown[], stats: null as unknown };
    const [coachs, transfers, squads, stats] = await Promise.all([
      list(`team:${teamId}:coachs`, week, "coachs", { team: String(teamId) }),
      list(`team:${teamId}:transfers`, week, "transfers", { team: String(teamId) }),
      list(`team:${teamId}:squad`, day, "players.squads", { team: String(teamId) }),
      kvCached<unknown>(`team:${teamId}:${season}:lgstats:${lg}`, 6 * H, async () => {
        const r = await runAfEndpoint("teams.statistics", { league: String(lg), season: String(season), team: String(teamId) });
        return r.response ?? null;
      }).catch(() => null),
    ]);
    // 现任教练 = career 中该队且 end=null;退而取第一条
    const coach =
      coachs.find((c) =>
        (dig(c, "career") as unknown[] | undefined)?.some?.(
          (j) => Number(dig(j, "team", "id")) === teamId && dig(j, "end") == null,
        ),
      ) ?? coachs[0] ?? null;
    const coachId = coach ? Number(dig(coach, "id")) : null;
    const trophies = coachId ? await list(`coach:${coachId}:trophies`, week, "trophies", { coach: String(coachId) }) : [];
    return { coach, transfers, squad: squads[0] ?? null, trophies, stats };
  };

  const [home, away] = await Promise.all([teamBlock(fx.home_id), teamBlock(fx.away_id)]);
  return {
    topscorers, topassists, topyellow, topred,
    coachHome: home.coach, coachAway: away.coach,
    transfersHome: home.transfers, transfersAway: away.transfers,
    squadHome: home.squad, squadAway: away.squad,
    statsHome: home.stats, statsAway: away.stats,
    trophiesHomeCoach: home.trophies, trophiesAwayCoach: away.trophies,
  };
}

export async function matchPanorama(fixtureId: number, opts: { deep?: boolean } = {}): Promise<Panorama | null> {
  const fx = await ensureBundle(fixtureId);
  if (!fx) return null;
  let bundle: Record<string, unknown> = {};
  try {
    bundle = JSON.parse(fx.payload) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  const injuries = await kvCached<unknown[]>(`fx:${fixtureId}:injuries`, 6 * H, async () => {
    const r = await runAfEndpoint("injuries", { fixture: String(fixtureId) });
    return Array.isArray(r.response) ? r.response : [];
  }).catch(() => [] as unknown[]);

  return {
    fixture: fx,
    bundle,
    odds: {
      ah: oddsSeries(fixtureId, "ah"),
      ou: oddsSeries(fixtureId, "ou"),
      eu: oddsSeries(fixtureId, "eu"),
      compareAh: oddsCompare(fixtureId, "ah"),
      compareOu: oddsCompare(fixtureId, "ou"),
      compareEu: oddsCompare(fixtureId, "eu"),
    },
    movements: movementsOf(fixtureId),
    prediction: (latestPrediction(fixtureId) as Record<string, unknown> | null) ?? null,
    injuries,
    deep: opts.deep ? await loadDeep(fx) : null,
  };
}
