import { z } from "zod";
import type { NormalizedOdds } from "../engine/types";
import type { injuriesPayloadSchema, lineupsPayloadSchema } from "./types";
import { politeFetchText } from "./httpCache";
import { normName } from "./polymarket";

/**
 * API-Football（api-sports.io v3）付费主源适配器：
 * 一把 key 同时供给——多家大书商盘口（1X2/亚盘/大小/波胆）、官方首发、伤停、权威赛果。
 * key 由服务器 env `API_FOOTBALL_KEY` 提供（绝不入库/入仓库）；未配置时整源静默缺席，
 * 因子表显示"未配置"，免费源链路照常运行。所有解析防御式：字段缺失只缺维度不抛链路。
 */

export const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

export function apiFootballKey(): string | null {
  const k = process.env.API_FOOTBALL_KEY?.trim();
  return k ? k : null;
}

export function apiFootballConfigured(): boolean {
  return apiFootballKey() !== null;
}

async function afGet(path: string, force = false): Promise<unknown> {
  const key = apiFootballKey();
  if (!key) throw new Error("API_FOOTBALL_KEY 未配置");
  const { body } = await politeFetchText(`${API_FOOTBALL_BASE}${path}`, force, {
    "x-apisports-key": key,
    accept: "application/json",
  });
  const parsed = JSON.parse(body) as { errors?: unknown; response?: unknown };
  // API-Football 把鉴权/配额错误放 errors 对象里、HTTP 仍 200
  if (parsed.errors && typeof parsed.errors === "object" && Object.keys(parsed.errors as object).length > 0) {
    throw new Error(`API-Football 错误：${JSON.stringify(parsed.errors).slice(0, 200)}`);
  }
  return parsed;
}

// ── 赛程/赛果 ────────────────────────────────────────────────────────────

export interface AfFixture {
  fixtureId: number;
  kickoffAt: number;
  statusShort: string;
  leagueName: string;
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
    status: z.object({ short: z.string() }).partial().default({}),
  }),
  league: z.object({ name: z.string() }).partial().default({}),
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
      leagueName: f.league.name ?? "",
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

export async function fetchAfFixturesByDate(dateUtc: string, force = false): Promise<AfFixture[]> {
  return parseAfFixtures(await afGet(`/fixtures?date=${dateUtc}&timezone=UTC`, force));
}

// ── 盘口（多书商） ────────────────────────────────────────────────────────

/** 书商名映射到因子权重表既有键（bookWeights），未列出的保持原名（默认权重 1） */
const BOOK_NAME_MAP: Record<string, string> = {
  Bet365: "bet365",
  Pinnacle: "Pinnacle",
  "William Hill": "威廉希尔",
};

/** 大书商优先序（拿不满时按出现顺序补足） */
const PREFERRED_BOOKS = ["Bet365", "Pinnacle", "William Hill", "Bwin", "Marathonbet", "1xBet", "Unibet", "Betfair"];
const MAX_BOOKS = 8;

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
  // 大书商优先 + 截断，避免长尾小庄刷快照
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
          .slice(0, 6);
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
          .slice(0, 6);
      } else if (bet.name === "Exact Score" || bet.name === "Correct Score") {
        const cs: { score: string; odds: number }[] = [];
        for (const v of bet.values) {
          const m = String(v.value).match(/^(\d+):(\d+)$/);
          const odd = oddNum(v.odd);
          if (m && odd) cs.push({ score: `${m[1]}:${m[2]}`, odds: odd });
        }
        if (cs.length >= 8) book.correctScores = cs.slice(0, 30);
      }
    }
    if (book.oneXTwo || book.ou.length > 0 || book.ah.length > 0) out.push(book);
  }
  return out;
}

export async function fetchAfOdds(fixtureId: number, capturedAt: number, force = false): Promise<NormalizedOdds[]> {
  return parseAfOddsBooks(await afGet(`/odds?fixture=${fixtureId}`, force), capturedAt);
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

// ── 体检 ────────────────────────────────────────────────────────────────

export async function probeApiFootball(): Promise<string> {
  if (!apiFootballConfigured()) {
    return "未配置：采购 api-sports.io key 后写入服务器 env 的 API_FOOTBALL_KEY 即自动生效";
  }
  const raw = (await afGet("/status", true)) as {
    response?: { subscription?: { plan?: string; end?: string }; requests?: { current?: number; limit_day?: number } };
  };
  const s = raw.response;
  return `已连通：套餐 ${s?.subscription?.plan ?? "?"}，今日配额 ${s?.requests?.current ?? "?"}/${s?.requests?.limit_day ?? "?"}`;
}
