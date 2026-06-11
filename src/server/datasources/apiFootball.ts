import { z } from "zod";
import type { NormalizedOdds } from "../engine/types";
import { getConfig } from "../lib/config";
import type { injuriesPayloadSchema, lineupsPayloadSchema } from "./types";
import { politeFetchText } from "./httpCache";
import { normName } from "./util";

/**
 * API-Football（api-sports.io v3）付费主源适配器：
 * 一把 key 同时供给——多家大书商盘口（1X2/亚盘/大小/波胆）、官方首发、伤停、权威赛果。
 * key 由服务器 env `API_FOOTBALL_KEY` 提供（绝不入库/入仓库）；未配置时整源静默缺席，
 * 因子表显示"未配置"，免费源链路照常运行。所有解析防御式：字段缺失只缺维度不抛链路。
 */

export const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

/** key 解析顺序：后台设置（settings.datasources.apiFootballKey）→ 服务器 env */
export function apiFootballKey(): string | null {
  try {
    const cfg = getConfig("datasources").apiFootballKey?.trim();
    if (cfg) return cfg;
  } catch {
    /* 设置表不可用时回落 env */
  }
  const k = process.env.API_FOOTBALL_KEY?.trim();
  return k ? k : null;
}

export function apiFootballConfigured(): boolean {
  return apiFootballKey() !== null;
}

/** AF v3 统一响应信封：所有端点同构（get/parameters/errors/results/paging/response） */
export interface AfRawResponse {
  get?: string;
  parameters?: Record<string, string> | unknown[];
  errors?: unknown;
  results?: number;
  paging?: { current?: number; total?: number };
  response?: unknown;
}

/** AF 把鉴权/配额/参数错误放 errors（对象，非空）里、HTTP 仍 200；空数组表示无错 */
export function afHasErrors(parsed: AfRawResponse): boolean {
  const e = parsed.errors;
  return !!e && typeof e === "object" && !Array.isArray(e) && Object.keys(e as object).length > 0;
}

/**
 * 通用原始调用：任意 v3 端点路径 → 完整响应信封（不对 errors 抛错，交由调用方处置）。
 * 全站「套壳」数据中心与各专用解析器共用此入口；key 缺失才抛（整源缺席）。
 */
export async function afGetRaw(path: string, force = false): Promise<AfRawResponse> {
  const key = apiFootballKey();
  if (!key) throw new Error("API_FOOTBALL_KEY 未配置");
  const { body } = await politeFetchText(`${API_FOOTBALL_BASE}${path}`, force, {
    "x-apisports-key": key,
    accept: "application/json",
  });
  return JSON.parse(body) as AfRawResponse;
}

async function afGet(path: string, force = false): Promise<unknown> {
  const parsed = await afGetRaw(path, force);
  if (afHasErrors(parsed)) {
    throw new Error(`API-Football 错误：${JSON.stringify(parsed.errors).slice(0, 200)}`);
  }
  return parsed;
}

// ── 赛程/赛果 ────────────────────────────────────────────────────────────

export interface AfFixture {
  fixtureId: number;
  kickoffAt: number;
  statusShort: string;
  leagueId: number | null;
  leagueName: string;
  season: number | null;
  referee: string | null;
  venueName: string | null;
  venueCity: string | null;
  homeId: number;
  awayId: number;
  homeName: string;
  awayName: string;
  /** 90 分钟常规时间比分（含补时，不含加时点球）——我们全站的结算口径 */
  ftHome: number | null;
  ftAway: number | null;
}

const afFixtureSchema = z.object({
  fixture: z.object({
    id: z.number(),
    timestamp: z.number(),
    referee: z.string().nullable().default(null),
    venue: z.object({ name: z.string().nullable().default(null), city: z.string().nullable().default(null) }).partial().default({}),
    status: z.object({ short: z.string() }).partial().default({}),
  }),
  league: z.object({ id: z.number(), name: z.string(), season: z.number() }).partial().default({}),
  teams: z.object({
    home: z.object({ id: z.number(), name: z.string() }),
    away: z.object({ id: z.number(), name: z.string() }),
  }),
  score: z
    .object({ fulltime: z.object({ home: z.number().nullable(), away: z.number().nullable() }).partial().default({}) })
    .partial()
    .default({}),
});

export function parseAfFixtures(json: unknown): AfFixture[] {
  const resp = (json as { response?: unknown[] }).response ?? [];
  const out: AfFixture[] = [];
  for (const raw of resp) {
    const p = afFixtureSchema.safeParse(raw);
    if (!p.success) continue;
    const f = p.data;
    out.push({
      fixtureId: f.fixture.id,
      kickoffAt: f.fixture.timestamp * 1000,
      statusShort: f.fixture.status.short ?? "",
      leagueId: f.league.id ?? null,
      leagueName: f.league.name ?? "",
      season: f.league.season ?? null,
      referee: f.fixture.referee,
      venueName: f.fixture.venue?.name ?? null,
      venueCity: f.fixture.venue?.city ?? null,
      homeId: f.teams.home.id,
      awayId: f.teams.away.id,
      homeName: f.teams.home.name,
      awayName: f.teams.away.name,
      ftHome: f.score.fulltime?.home ?? null,
      ftAway: f.score.fulltime?.away ?? null,
    });
  }
  return out;
}

/** FT/AET/PEN 都算"常规时间已出"（fulltime 字段即 90 分钟比分） */
export function afFixtureFinished(f: AfFixture): boolean {
  return ["FT", "AET", "PEN"].includes(f.statusShort) && f.ftHome !== null && f.ftAway !== null;
}

export interface AfMatchRef {
  homeNames: string[];
  awayNames: string[];
  kickoffAt: number;
}

/** 双队名（含别名）归一匹配 + 开球时间 ±36h 容差（与 ESPN 匹配同一口径） */
export function matchAfFixture(fixtures: AfFixture[], ref: AfMatchRef): AfFixture | null {
  const homeSet = new Set(ref.homeNames.map(normName));
  const awaySet = new Set(ref.awayNames.map(normName));
  let best: AfFixture | null = null;
  for (const f of fixtures) {
    if (!homeSet.has(normName(f.homeName)) || !awaySet.has(normName(f.awayName))) continue;
    if (Math.abs(f.kickoffAt - ref.kickoffAt) > 36 * 3_600_000) continue;
    if (!best || Math.abs(f.kickoffAt - ref.kickoffAt) < Math.abs(best.kickoffAt - ref.kickoffAt)) best = f;
  }
  return best;
}

/**
 * 同日多场比赛共用一条 fixtures URL：进程内缓存（TTL 略长于 politeFetch 冷却），
 * 既省配额，又避免第二场撞上冷却报错、连败计数误触发整源自动停用。
 */
const fixturesCache = new Map<string, { at: number; data: AfFixture[] }>();
const CACHE_TTL_MS = 11 * 60_000;

export async function fetchAfFixturesByDate(dateUtc: string, force = false): Promise<AfFixture[]> {
  const hit = fixturesCache.get(dateUtc);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = parseAfFixtures(await afGet(`/fixtures?date=${dateUtc}&timezone=UTC`, force));
  fixturesCache.set(dateUtc, { at: Date.now(), data });
  return data;
}

// ── 盘口（多书商） ────────────────────────────────────────────────────────

/** 书商名映射到因子权重表既有键（bookWeights），未列出的保持原名（默认权重 1） */
const BOOK_NAME_MAP: Record<string, string> = {
  Bet365: "bet365",
  Pinnacle: "Pinnacle",
  "William Hill": "威廉希尔",
};

/** 展示优先序（锐盘/大盘排前，便于价差监测识别）；不截断，全量入库 */
const PREFERRED_BOOKS = ["Pinnacle", "Bet365", "William Hill", "Bwin", "Marathonbet", "1xBet", "Unibet", "Betfair", "888sport", "Betsson", "Betano"];
/** 安全上限（防御异常巨量 payload；AF 实际一场约 20-30 家，全收） */
const MAX_BOOKS = 60;
/** 每市场盘口线安全上限（亚盘/大小球梯度可达十余条，全收） */
const MAX_LINES = 25;

const afOddsSchema = z.object({
  bookmakers: z
    .array(
      z.object({
        name: z.string(),
        bets: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.union([z.string(), z.number()]), odd: z.string() })) })),
      }),
    )
    .default([]),
});

function oddNum(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) && n >= 1.01 && n <= 100 ? n : null;
}

/** "Home -1" / "Away +0.5" → 主队口径让球线 */
function parseAhValue(value: string): { side: "home" | "away"; line: number } | null {
  const m = value.trim().match(/^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const raw = Number(m[2]);
  if (!Number.isFinite(raw)) return null;
  const side = m[1].toLowerCase() as "home" | "away";
  // API-Football 的让球值是该侧自身盘口：Home -1 与 Away +1 是同一条主让 -1 的两侧
  return { side, line: side === "home" ? raw : -raw };
}

export function parseAfOddsBooks(json: unknown, capturedAt: number): NormalizedOdds[] {
  const resp = (json as { response?: unknown[] }).response ?? [];
  const first = resp[0];
  if (!first) return [];
  const p = afOddsSchema.safeParse(first);
  if (!p.success) return [];
  // 锐盘/大盘排前（仅排序，不截断）——全量入库，多书商让共识与价差监测更准
  const ranked = [...p.data.bookmakers].sort((a, b) => {
    const ia = PREFERRED_BOOKS.indexOf(a.name);
    const ib = PREFERRED_BOOKS.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const out: NormalizedOdds[] = [];
  for (const bm of ranked.slice(0, MAX_BOOKS)) {
    const book: NormalizedOdds = { bookmaker: BOOK_NAME_MAP[bm.name] ?? bm.name, ou: [], ah: [], capturedAt };
    for (const bet of bm.bets) {
      if (bet.name === "Match Winner") {
        const get = (v: string) => oddNum(bet.values.find((x) => String(x.value) === v)?.odd ?? "");
        const home = get("Home");
        const draw = get("Draw");
        const away = get("Away");
        if (home && draw && away) book.oneXTwo = { home, draw, away };
      } else if (bet.name === "Goals Over/Under") {
        const byLine = new Map<number, { over?: number; under?: number }>();
        for (const v of bet.values) {
          const m = String(v.value).match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/i);
          const odd = oddNum(v.odd);
          if (!m || !odd) continue;
          const line = Number(m[2]);
          const cur = byLine.get(line) ?? {};
          if (/^over$/i.test(m[1])) cur.over = odd;
          else cur.under = odd;
          byLine.set(line, cur);
        }
        book.ou = [...byLine.entries()]
          .filter(([, v]) => v.over && v.under)
          .map(([line, v]) => ({ line, over: v.over!, under: v.under! }))
          .sort((a, b) => a.line - b.line)
          .slice(0, MAX_LINES);
      } else if (bet.name === "Asian Handicap") {
        const byLine = new Map<number, { home?: number; away?: number }>();
        for (const v of bet.values) {
          const ah = parseAhValue(String(v.value));
          const odd = oddNum(v.odd);
          if (!ah || !odd) continue;
          const cur = byLine.get(ah.line) ?? {};
          cur[ah.side] = odd;
          byLine.set(ah.line, cur);
        }
        book.ah = [...byLine.entries()]
          .filter(([, v]) => v.home && v.away)
          .map(([line, v]) => ({ line, home: v.home!, away: v.away! }))
          .sort((a, b) => a.line - b.line)
          .slice(0, MAX_LINES);
      } else if (bet.name === "Exact Score" || bet.name === "Correct Score") {
        const cs: { score: string; odds: number }[] = [];
        for (const v of bet.values) {
          const m = String(v.value).match(/^(\d+):(\d+)$/);
          const odd = oddNum(v.odd);
          if (m && odd) cs.push({ score: `${m[1]}:${m[2]}`, odds: odd });
        }
        if (cs.length >= 8) book.correctScores = cs.slice(0, 40);
      } else if (bet.name === "Goals Over/Under (3-way)" || /handicap result/i.test(bet.name)) {
        // 让球胜平负（竞彩口径，3 向让球）→ hhad
        const get = (v: string) => oddNum(bet.values.find((x) => String(x.value).toLowerCase().startsWith(v))?.odd ?? "");
        const home = get("home");
        const draw = get("draw");
        const away = get("away");
        if (home && draw && away) book.hhad = { line: 0, home, draw, away };
      }
    }
    if (book.oneXTwo || book.ou.length > 0 || book.ah.length > 0) out.push(book);
  }
  return out;
}

/** odds 分页：AF 一场盘口可能多页（每页 10 家书商），全部取回再合并 */
export async function fetchAfOdds(fixtureId: number, capturedAt: number, force = false): Promise<NormalizedOdds[]> {
  const first = (await afGet(`/odds?fixture=${fixtureId}`, force)) as { paging?: { total?: number }; response?: unknown[] };
  const books = parseAfOddsBooks(first, capturedAt);
  const totalPages = Math.min(first.paging?.total ?? 1, 5); // 安全上限 5 页（≈50 家）
  const seen = new Set(books.map((b) => b.bookmaker));
  for (let pg = 2; pg <= totalPages; pg++) {
    try {
      const more = parseAfOddsBooks(await afGet(`/odds?fixture=${fixtureId}&page=${pg}`, force), capturedAt);
      for (const b of more) if (!seen.has(b.bookmaker)) (seen.add(b.bookmaker), books.push(b));
    } catch {
      break; // 分页失败不影响已取到的
    }
  }
  return books;
}

// ── 官方首发 ─────────────────────────────────────────────────────────────

const afLineupSchema = z.array(
  z.object({
    team: z.object({ id: z.number() }),
    formation: z.string().nullable().default(null),
    startXI: z.array(z.object({ player: z.object({ name: z.string() }) })).default([]),
  }),
);

export function parseAfLineups(json: unknown, homeId: number): z.infer<typeof lineupsPayloadSchema> | null {
  const p = afLineupSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success || p.data.length < 2) return null;
  const side = (isHome: boolean) => {
    const t = p.data.find((x) => (x.team.id === homeId) === isHome);
    return t
      ? { formation: t.formation ?? undefined, starters: t.startXI.map((s) => s.player.name).filter(Boolean) }
      : { starters: [] as string[] };
  };
  const home = side(true);
  const away = side(false);
  if (home.starters.length < 7 || away.starters.length < 7) return null; // 未公布/残缺不入库
  return { confirmed: true, home, away, note: "API-Football 官方首发" };
}

export async function fetchAfLineups(fixtureId: number, homeId: number, force = false) {
  return parseAfLineups(await afGet(`/fixtures/lineups?fixture=${fixtureId}`, force), homeId);
}

// ── 伤停 ────────────────────────────────────────────────────────────────

const afInjurySchema = z.array(
  z.object({
    player: z.object({ name: z.string(), type: z.string().nullable().default(null), reason: z.string().nullable().default(null) }),
    team: z.object({ id: z.number() }),
  }),
);

export function parseAfInjuries(json: unknown, homeId: number, awayId: number): z.infer<typeof injuriesPayloadSchema> | null {
  const p = afInjurySchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success) return null;
  const items = p.data
    .filter((x) => x.team.id === homeId || x.team.id === awayId)
    .map((x) => ({
      team: (x.team.id === homeId ? "home" : "away") as "home" | "away",
      player: x.player.name,
      role: "unknown" as const,
      importance: "regular" as const,
      status: x.player.type || "伤停",
      ...(x.player.reason ? { note: x.player.reason } : {}),
    }));
  return items.length > 0 ? { items } : null;
}

export async function fetchAfInjuries(fixtureId: number, homeId: number, awayId: number, force = false) {
  return parseAfInjuries(await afGet(`/injuries?fixture=${fixtureId}`, force), homeId, awayId);
}

// ── 球队名单（球员数据维度） ──────────────────────────────────────────────

export interface AfPlayer {
  name: string;
  age: number | null;
  number: number | null;
  role: "goalkeeper" | "defender" | "midfielder" | "attacker" | "unknown";
}

const afSquadSchema = z.array(
  z.object({
    players: z
      .array(
        z.object({
          name: z.string(),
          age: z.number().nullable().default(null),
          number: z.number().nullable().default(null),
          position: z.string().nullable().default(null),
        }),
      )
      .default([]),
  }),
);

const POSITION_ROLE: Record<string, AfPlayer["role"]> = {
  Goalkeeper: "goalkeeper",
  Defender: "defender",
  Midfielder: "midfielder",
  Attacker: "attacker",
};

export function parseAfSquad(json: unknown): AfPlayer[] {
  const p = afSquadSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success || p.data.length === 0) return [];
  return p.data[0].players.map((x) => ({
    name: x.name,
    age: x.age,
    number: x.number,
    role: POSITION_ROLE[x.position ?? ""] ?? "unknown",
  }));
}

export async function fetchAfSquad(teamId: number, force = false): Promise<AfPlayer[]> {
  return parseAfSquad(await afGet(`/players/squads?team=${teamId}`, force));
}

// ── 积分榜 ───────────────────────────────────────────────────────────────

export interface AfStandingRow {
  rank: number;
  teamId: number;
  team: string;
  played: number;
  points: number;
  gd: number;
  group: string;
}

const afStandingsSchema = z.array(
  z.object({
    league: z.object({
      standings: z
        .array(
          z.array(
            z.object({
              rank: z.number(),
              team: z.object({ id: z.number(), name: z.string() }),
              points: z.number(),
              goalsDiff: z.number(),
              group: z.string().nullable().default(null),
              all: z.object({ played: z.number() }).partial().default({}),
            }),
          ),
        )
        .default([]),
    }),
  }),
);

export function parseAfStandings(json: unknown): AfStandingRow[] {
  const p = afStandingsSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success || p.data.length === 0) return [];
  const out: AfStandingRow[] = [];
  for (const grp of p.data[0].league.standings) {
    for (const r of grp) {
      out.push({
        rank: r.rank,
        teamId: r.team.id,
        team: r.team.name,
        played: r.all.played ?? 0,
        points: r.points,
        gd: r.goalsDiff,
        group: r.group ?? "",
      });
    }
  }
  return out;
}

/** 同联赛多场比赛共用积分榜 URL：同样进程内缓存防冷却冲突 */
const standingsCache = new Map<string, { at: number; data: AfStandingRow[] }>();

export async function fetchAfStandings(leagueId: number, season: number, force = false): Promise<AfStandingRow[]> {
  const key = `${leagueId}|${season}`;
  const hit = standingsCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = parseAfStandings(await afGet(`/standings?league=${leagueId}&season=${season}`, force));
  standingsCache.set(key, { at: Date.now(), data });
  return data;
}

// ── 历史交锋（fixtures/headtohead） ────────────────────────────────────────

export interface AfH2h {
  matches: { playedAt: number; homeTeam: string; awayTeam: string; homeGoals: number; awayGoals: number; competition?: string }[];
  summary: { total: number; homeWins: number; draws: number; awayWins: number };
}

/** homeId/awayId 为本场主客，用于把历史结果归并到"本场主队胜/平/本场客队胜"口径 */
export function parseAfH2h(json: unknown, homeId: number, awayId: number): AfH2h | null {
  const fixtures = parseAfFixtures(json).filter((f) => f.ftHome !== null && f.ftAway !== null);
  if (fixtures.length === 0) return null;
  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  // 全部已完赛交锋纳入胜平负统计；展示保留最近 15 场
  const sorted = fixtures.sort((a, b) => b.kickoffAt - a.kickoffAt);
  for (const f of sorted) {
    const winnerTeamId = f.ftHome! > f.ftAway! ? f.homeId : f.ftHome! < f.ftAway! ? f.awayId : null;
    if (winnerTeamId === homeId) homeWins++;
    else if (winnerTeamId === awayId) awayWins++;
    else draws++;
  }
  const matches = sorted.slice(0, 15).map((f) => ({
    playedAt: f.kickoffAt,
    homeTeam: f.homeName,
    awayTeam: f.awayName,
    homeGoals: f.ftHome!,
    awayGoals: f.ftAway!,
    competition: f.leagueName || undefined,
  }));
  return { matches, summary: { total: sorted.length, homeWins, draws, awayWins } };
}

export async function fetchAfH2h(homeId: number, awayId: number, force = false): Promise<AfH2h | null> {
  return parseAfH2h(await afGet(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=20`, force), homeId, awayId);
}

// ── 球队赛季统计（teams/statistics） ───────────────────────────────────────

export interface AfTeamStats {
  matches: number;
  gfPerGame: number;
  gaPerGame: number;
  cleanSheetRate: number;
  homeGfPerGame: number | null;
  homeGaPerGame: number | null;
  awayGfPerGame: number | null;
  awayGaPerGame: number | null;
  /** 近期战绩串（如 "WWDLW"）+ 主用阵型，喂研报事实 */
  form: string;
  formation: string | null;
  // —— 富化字段（teams/statistics 深度，玩家爱看） ——
  wins: number;
  draws: number;
  loses: number;
  winStreak: number;
  penaltyScored: number;
  penaltyTotal: number;
  failedToScoreRate: number;
  biggestWin: string | null;
}

const afTeamStatsSchema = z.object({
  form: z.string().nullable().default(null),
  fixtures: z
    .object({
      played: z.object({ home: z.number(), away: z.number(), total: z.number() }).partial().default({}),
      wins: z.object({ total: z.number() }).partial().default({}),
      draws: z.object({ total: z.number() }).partial().default({}),
      loses: z.object({ total: z.number() }).partial().default({}),
    })
    .partial()
    .default({}),
  goals: z
    .object({
      for: z.object({ average: z.object({ home: z.string(), away: z.string(), total: z.string() }).partial().default({}) }).partial().default({}),
      against: z.object({ average: z.object({ home: z.string(), away: z.string(), total: z.string() }).partial().default({}) }).partial().default({}),
    })
    .partial()
    .default({}),
  clean_sheet: z.object({ total: z.number() }).partial().default({}),
  failed_to_score: z.object({ total: z.number() }).partial().default({}),
  biggest: z
    .object({ streak: z.object({ wins: z.number() }).partial().default({}), wins: z.object({ home: z.string().nullable(), away: z.string().nullable() }).partial().default({}) })
    .partial()
    .default({}),
  penalty: z.object({ scored: z.object({ total: z.number() }).partial().default({}), total: z.number().nullable().default(null) }).partial().default({}),
  lineups: z.array(z.object({ formation: z.string(), played: z.number() })).default([]),
});

function numOr(s: string | undefined, d: number | null): number | null {
  if (s === undefined) return d;
  const n = Number(s);
  return Number.isFinite(n) ? n : d;
}

export function parseAfTeamStats(json: unknown): AfTeamStats | null {
  const resp = (json as { response?: unknown }).response;
  const p = afTeamStatsSchema.safeParse(resp);
  if (!p.success) return null;
  const s = p.data;
  const played = s.fixtures.played?.total ?? 0;
  if (played === 0) return null;
  const topFormation = [...s.lineups].sort((a, b) => b.played - a.played)[0]?.formation ?? null;
  const biggestWin = s.biggest?.wins?.home || s.biggest?.wins?.away || null;
  return {
    matches: played,
    gfPerGame: numOr(s.goals.for?.average?.total, 0) ?? 0,
    gaPerGame: numOr(s.goals.against?.average?.total, 0) ?? 0,
    cleanSheetRate: played > 0 ? (s.clean_sheet?.total ?? 0) / played : 0,
    homeGfPerGame: numOr(s.goals.for?.average?.home, null),
    homeGaPerGame: numOr(s.goals.against?.average?.home, null),
    awayGfPerGame: numOr(s.goals.for?.average?.away, null),
    awayGaPerGame: numOr(s.goals.against?.average?.away, null),
    form: (s.form ?? "").slice(-6),
    formation: topFormation,
    wins: s.fixtures.wins?.total ?? 0,
    draws: s.fixtures.draws?.total ?? 0,
    loses: s.fixtures.loses?.total ?? 0,
    winStreak: s.biggest?.streak?.wins ?? 0,
    penaltyScored: s.penalty?.scored?.total ?? 0,
    penaltyTotal: s.penalty?.total ?? 0,
    failedToScoreRate: played > 0 ? (s.failed_to_score?.total ?? 0) / played : 0,
    biggestWin,
  };
}

export async function fetchAfTeamStats(teamId: number, leagueId: number, season: number, force = false): Promise<AfTeamStats | null> {
  return parseAfTeamStats(await afGet(`/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`, force));
}

// ── 预测（predictions：AF 蒸馏概率 + 期望进球，引擎主源） ────────────────────

export interface AfPrediction {
  /** 1X2 概率（已归一） */
  home: number;
  draw: number;
  away: number;
  /** AF 预测的两队期望进球（驱动比分矩阵 → 亚盘/大小球派生）；缺则 null */
  expGoalsHome: number | null;
  expGoalsAway: number | null;
  advice: string | null;
}

const afPredictionSchema = z.array(
  z.object({
    predictions: z
      .object({
        percent: z.object({ home: z.string(), draw: z.string(), away: z.string() }).partial().default({}),
        goals: z.object({ home: z.union([z.string(), z.number()]).nullable(), away: z.union([z.string(), z.number()]).nullable() }).partial().default({}),
        advice: z.string().nullable().default(null),
      })
      .partial()
      .default({}),
  }),
);

const pctNum = (s: string | undefined): number => {
  if (!s) return 0;
  const n = Number(s.replace("%", ""));
  return Number.isFinite(n) ? n : 0;
};
const goalNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  // AF goals 形如 "-1.5"/"2.3"（相对/绝对），取绝对值作期望进球粗估；负号表示弱于对手，用 abs 不合适
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseAfPrediction(json: unknown): AfPrediction | null {
  const p = afPredictionSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success || p.data.length === 0) return null;
  const pr = p.data[0].predictions;
  const h = pctNum(pr.percent?.home);
  const d = pctNum(pr.percent?.draw);
  const a = pctNum(pr.percent?.away);
  const sum = h + d + a;
  if (sum <= 0) return null;
  return {
    home: h / sum,
    draw: d / sum,
    away: a / sum,
    expGoalsHome: goalNum(pr.goals?.home),
    expGoalsAway: goalNum(pr.goals?.away),
    advice: pr.advice ?? null,
  };
}

export async function fetchAfPrediction(fixtureId: number, force = false): Promise<AfPrediction | null> {
  return parseAfPrediction(await afGet(`/predictions?fixture=${fixtureId}`, force));
}

// ── 主教练（coachs） ───────────────────────────────────────────────────────

const afCoachSchema = z.array(z.object({ name: z.string(), career: z.array(z.object({ team: z.object({ id: z.number() }).partial().default({}), end: z.string().nullable().default(null) })).default([]) }));

/** 取该队当前主教练（career 中 end===null 的一段；缺则取首条） */
export function parseAfCoach(json: unknown, teamId: number): string | null {
  const p = afCoachSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success || p.data.length === 0) return null;
  const current = p.data.find((c) => c.career.some((e) => e.team.id === teamId && e.end === null));
  return (current ?? p.data[0]).name || null;
}

export async function fetchAfCoach(teamId: number, force = false): Promise<string | null> {
  return parseAfCoach(await afGet(`/coachs?team=${teamId}`, force), teamId);
}

// ── 联赛射手榜（players/topscorers） ───────────────────────────────────────

export interface AfScorer {
  teamId: number;
  player: string;
  goals: number;
}

const afScorersSchema = z.array(
  z.object({
    player: z.object({ name: z.string() }),
    statistics: z.array(z.object({ team: z.object({ id: z.number() }), goals: z.object({ total: z.number().nullable().default(null) }).partial().default({}) })).default([]),
  }),
);

export function parseAfTopScorers(json: unknown): AfScorer[] {
  const p = afScorersSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success) return [];
  const out: AfScorer[] = [];
  for (const row of p.data) {
    const st = row.statistics[0];
    if (!st) continue;
    out.push({ teamId: st.team.id, player: row.player.name, goals: st.goals?.total ?? 0 });
  }
  return out;
}

const scorersCache = new Map<string, { at: number; data: AfScorer[] }>();
export async function fetchAfTopScorers(leagueId: number, season: number, force = false): Promise<AfScorer[]> {
  const key = `${leagueId}|${season}`;
  const hit = scorersCache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = parseAfTopScorers(await afGet(`/players/topscorers?league=${leagueId}&season=${season}`, force));
  scorersCache.set(key, { at: Date.now(), data });
  return data;
}

// ── 近期状态（fixtures + fixtures/statistics：射门/射正/控球/xG） ───────────

export interface AfFormMatch {
  playedAt: number;
  opponent: string;
  venue: "home" | "away";
  goalsFor: number;
  goalsAgainst: number;
  shots?: number;
  shotsOnTarget?: number;
  /** 本队该场 xG（进攻质量） */
  xg?: number;
  /** 对手该场 xG = 本队被创造的预期失球（防守质量） */
  xgAgainst?: number;
  possession?: number;
}

/** 某队近 N 场已完赛（相对该队的进失球/对手/主客 + 对手 id 供取防守 xG） */
export function parseAfTeamFixtures(json: unknown, teamId: number): { fixtureId: number; opponentId: number; m: AfFormMatch }[] {
  const out: { fixtureId: number; opponentId: number; m: AfFormMatch }[] = [];
  for (const f of parseAfFixtures(json)) {
    if (f.ftHome === null || f.ftAway === null) continue;
    const isHome = f.homeId === teamId;
    if (!isHome && f.awayId !== teamId) continue;
    out.push({
      fixtureId: f.fixtureId,
      opponentId: isHome ? f.awayId : f.homeId,
      m: {
        playedAt: f.kickoffAt,
        opponent: isHome ? f.awayName : f.homeName,
        venue: isHome ? "home" : "away",
        goalsFor: isHome ? f.ftHome : f.ftAway,
        goalsAgainst: isHome ? f.ftAway : f.ftHome,
      },
    });
  }
  return out;
}

const afStatBlockSchema = z.array(
  z.object({
    team: z.object({ id: z.number() }),
    statistics: z.array(z.object({ type: z.string(), value: z.union([z.number(), z.string()]).nullable().default(null) })).default([]),
  }),
);

/** 单场某队的射门/射正/控球/xG（字段缺失返回部分） */
export function parseAfFixtureStats(json: unknown, teamId: number): Pick<AfFormMatch, "shots" | "shotsOnTarget" | "xg" | "possession"> {
  const p = afStatBlockSchema.safeParse((json as { response?: unknown }).response ?? []);
  if (!p.success) return {};
  const block = p.data.find((b) => b.team.id === teamId);
  if (!block) return {};
  const get = (type: string): number | undefined => {
    const v = block.statistics.find((s) => s.type === type)?.value;
    if (v === null || v === undefined) return undefined;
    const n = typeof v === "string" ? Number(v.replace("%", "")) : v;
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    shots: get("Total Shots"),
    shotsOnTarget: get("Shots on Goal"),
    xg: get("expected_goals"),
    possession: get("Ball Possession"),
  };
}

/** 单场统计：一次请求拿回两队 → 本队 xG（进攻）+ 对手 xG（防守失） */
async function fetchAfFixtureStatsBoth(
  fixtureId: number,
  teamId: number,
  opponentId: number,
  force = false,
): Promise<Pick<AfFormMatch, "shots" | "shotsOnTarget" | "xg" | "possession" | "xgAgainst">> {
  const json = await afGet(`/fixtures/statistics?fixture=${fixtureId}`, force);
  const mine = parseAfFixtureStats(json, teamId);
  const opp = parseAfFixtureStats(json, opponentId);
  return { ...mine, xgAgainst: opp.xg };
}

/** 球队近 N 场状态（含两侧 xG）：1 次 fixtures + N 次 statistics。Ultra 配额下取满 10 场 */
export async function fetchAfTeamForm(teamId: number, last = 10, force = false): Promise<AfFormMatch[]> {
  const recent = parseAfTeamFixtures(await afGet(`/fixtures?team=${teamId}&last=${last}`, force), teamId);
  const enriched = await Promise.all(
    recent.map(async ({ fixtureId, opponentId, m }) => {
      const st = await fetchAfFixtureStatsBoth(fixtureId, teamId, opponentId, force).catch(() => ({}));
      return { ...m, ...st };
    }),
  );
  return enriched.sort((a, b) => b.playedAt - a.playedAt);
}

// ── 体检 ────────────────────────────────────────────────────────────────

export async function probeApiFootball(): Promise<string> {
  if (!apiFootballConfigured()) {
    return "未配置：在 系统设置→数据源 填入 API-Football key（或服务器 env API_FOOTBALL_KEY）即自动生效";
  }
  const raw = (await afGet("/status", true)) as {
    response?: { subscription?: { plan?: string; end?: string }; requests?: { current?: number; limit_day?: number } };
  };
  const s = raw.response;
  return `已连通：套餐 ${s?.subscription?.plan ?? "?"}，今日配额 ${s?.requests?.current ?? "?"}/${s?.requests?.limit_day ?? "?"}`;
}
