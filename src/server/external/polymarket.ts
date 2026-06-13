import { kvCached, kvGet } from "../af/store";
import type { PublicMarketSignal } from "../views/report-signals";

const GAMMA_SEARCH = "https://gamma-api.polymarket.com/public-search";
const TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 1800;
const MIN_EDGE = 0.04;

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(fc|sc|cf|club|women|u\d+|national|team)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((x) => x.length >= 3);
}

function parseJsonish(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function marketUrl(slug: unknown): string | undefined {
  return typeof slug === "string" && slug ? `https://polymarket.com/event/${slug}` : undefined;
}

function sideFromProb(homeProb: number | null, awayProb: number | null): PublicMarketSignal["side"] {
  if (homeProb == null || awayProb == null || Math.abs(homeProb - awayProb) < MIN_EDGE) return null;
  return homeProb > awayProb ? "home" : "away";
}

function probsFromOutcomePrices(homeName: string, awayName: string, outcomes: unknown[], prices: unknown[]): {
  homeProb: number | null;
  drawProb: number | null;
  awayProb: number | null;
} {
  const homeTokens = tokens(homeName);
  const awayTokens = tokens(awayName);
  let homeProb: number | null = null;
  let awayProb: number | null = null;
  let drawProb: number | null = null;
  for (let i = 0; i < outcomes.length; i++) {
    const label = norm(String(outcomes[i] ?? ""));
    const price = num(prices[i]);
    if (price == null || price < 0 || price > 1) continue;
    if (/\b(draw|tie)\b/.test(label)) drawProb = Math.max(drawProb ?? -1, price);
    if (homeTokens.some((t) => label.includes(t))) homeProb = Math.max(homeProb ?? -1, price);
    if (awayTokens.some((t) => label.includes(t))) awayProb = Math.max(awayProb ?? -1, price);
  }
  return { homeProb, drawProb, awayProb };
}

function exactishMatch(text: string, homeName: string, awayName: string): boolean {
  const hay = norm(text);
  const ht = tokens(homeName);
  const at = tokens(awayName);
  return ht.some((t) => hay.includes(t)) && at.some((t) => hay.includes(t));
}

function marketsOfEvent(ev: Record<string, unknown>): Record<string, unknown>[] {
  const markets = ev.markets;
  return Array.isArray(markets) ? (markets.filter((m) => m && typeof m === "object") as Record<string, unknown>[]) : [];
}

function closedOrInactive(x: Record<string, unknown>): boolean {
  return x.active === false || x.closed === true || x.archived === true;
}

function binaryYesPrice(market: Record<string, unknown>): number | null {
  const outcomes = parseJsonish(market.outcomes);
  const prices = parseJsonish(market.outcomePrices);
  const yesIndex = outcomes.findIndex((x) => norm(String(x ?? "")) === "yes");
  if (yesIndex < 0) return null;
  const price = num(prices[yesIndex]);
  return price != null && price >= 0 && price <= 1 ? price : null;
}

function sideOfBinaryQuestion(market: Record<string, unknown>, homeName: string, awayName: string): "home" | "away" | "draw" | null {
  const text = norm(`${market.question ?? ""} ${market.title ?? ""} ${market.groupItemTitle ?? ""} ${market.slug ?? ""}`);
  if (/\b(draw|tie)\b/.test(text)) return "draw";
  const homeTokens = tokens(homeName);
  const awayTokens = tokens(awayName);
  const hasHome = homeTokens.some((t) => text.includes(t));
  const hasAway = awayTokens.some((t) => text.includes(t));
  if (hasHome && !hasAway) return "home";
  if (hasAway && !hasHome) return "away";
  return null;
}

function probsFromBinaryMarkets(markets: Record<string, unknown>[], homeName: string, awayName: string): {
  homeProb: number | null;
  drawProb: number | null;
  awayProb: number | null;
} {
  let homeProb: number | null = null;
  let drawProb: number | null = null;
  let awayProb: number | null = null;
  for (const market of markets) {
    if (closedOrInactive(market)) continue;
    const yes = binaryYesPrice(market);
    if (yes == null) continue;
    const side = sideOfBinaryQuestion(market, homeName, awayName);
    if (side === "home") homeProb = Math.max(homeProb ?? -1, yes);
    if (side === "draw") drawProb = Math.max(drawProb ?? -1, yes);
    if (side === "away") awayProb = Math.max(awayProb ?? -1, yes);
  }
  return { homeProb, drawProb, awayProb };
}

function bestMultiOutcomeProbs(markets: Record<string, unknown>[], homeName: string, awayName: string): {
  homeProb: number | null;
  drawProb: number | null;
  awayProb: number | null;
} {
  for (const market of markets) {
    if (closedOrInactive(market)) continue;
    const outcomes = parseJsonish(market.outcomes);
    const prices = parseJsonish(market.outcomePrices);
    const probs = probsFromOutcomePrices(homeName, awayName, outcomes, prices);
    if (probs.homeProb != null && probs.awayProb != null) return probs;
  }
  return { homeProb: null, drawProb: null, awayProb: null };
}

function pickMarket(events: unknown[], homeName: string, awayName: string): PublicMarketSignal {
  for (const evRaw of events) {
    if (!evRaw || typeof evRaw !== "object") continue;
    const ev = evRaw as Record<string, unknown>;
    if (closedOrInactive(ev)) continue;
    const evText = `${ev.title ?? ""} ${ev.slug ?? ""}`;
    if (!exactishMatch(evText, homeName, awayName)) continue;
    const markets = marketsOfEvent(ev);
    const binary = probsFromBinaryMarkets(markets, homeName, awayName);
    const multi = binary.homeProb != null || binary.awayProb != null ? binary : bestMultiOutcomeProbs(markets, homeName, awayName);
    const side = sideFromProb(multi.homeProb, multi.awayProb);
    if (multi.homeProb != null || multi.awayProb != null || multi.drawProb != null) {
      return {
        status: "ok",
        source: "Polymarket",
        note: "命中 Polymarket 公开事件/市场",
        url: marketUrl(ev.slug),
        side,
        homeProb: multi.homeProb,
        drawProb: multi.drawProb,
        awayProb: multi.awayProb,
        capturedAt: Date.now(),
      };
    }
    return {
      status: "ok",
      source: "Polymarket",
      note: "命中 Polymarket 公开事件,但未找到可映射胜负 outcome",
      url: marketUrl(ev.slug),
      side: null,
      capturedAt: Date.now(),
    };
  }
  return { status: "missing", source: "Polymarket", note: "Polymarket 暂无本场可精确匹配的公开市场", capturedAt: Date.now() };
}

async function searchEvents(query: string): Promise<unknown[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      q: query,
      cache: "true",
      events_status: "open",
      limit_per_type: "10",
      sort: "volume",
      ascending: "false",
    });
    const url = `${GAMMA_SEARCH}?${params}`;
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Polymarket ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json?.events)) return json.events;
    if (Array.isArray(json?.data)) return json.data;
    return Array.isArray(json) ? json : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function findPolymarketSignal(
  homeName: string,
  awayName: string,
  opts: { kickoffAt?: number | null; fixtureId?: number | null } = {},
): Promise<PublicMarketSignal> {
  const legacyKey = `poly:${norm(homeName)}:${norm(awayName)}`;
  const key = opts.fixtureId ? `poly:fx:${opts.fixtureId}:${norm(homeName)}:${norm(awayName)}` : legacyKey;
  if (opts.kickoffAt != null && Date.now() >= opts.kickoffAt) {
    const raws = [kvGet(key), key === legacyKey ? null : kvGet(legacyKey)];
    for (const raw of raws) {
      if (!raw) continue;
      try {
        const cached = JSON.parse(raw) as { data?: PublicMarketSignal };
        if (cached.data?.capturedAt && cached.data.capturedAt < opts.kickoffAt) return cached.data;
      } catch {
        /* ignore malformed cache */
      }
    }
    return { status: "skipped", source: "Polymarket", note: "已开赛,不使用即时预测市场避免赛后价格污染", capturedAt: Date.now() };
  }
  return kvCached<PublicMarketSignal>(
    key,
    TTL_MS,
    async () => {
      try {
        const seen = new Set<string>();
        const queries = [`${homeName} ${awayName}`, `${homeName} vs ${awayName}`, `${homeName} ${awayName} soccer`, homeName, awayName].filter((q) => {
          const n = norm(q);
          if (!n || seen.has(n)) return false;
          seen.add(n);
          return true;
        });
        const events = (await Promise.all(queries.map((q) => searchEvents(q).catch(() => [] as unknown[])))).flat();
        return pickMarket(events, homeName, awayName);
      } catch {
        return { status: "error", source: "Polymarket", note: "Polymarket 公开接口暂不可用", capturedAt: Date.now() };
      }
    },
    { emptyTtlMs: TTL_MS },
  );
}

export const __polymarketForTest = { pickMarket };
