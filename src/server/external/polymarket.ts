import { kvCached } from "../af/store";
import type { PublicMarketSignal } from "../views/report-signals";

const GAMMA_EVENTS = "https://gamma-api.polymarket.com/events";
const TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 1800;

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

function marketUrl(slug: unknown): string | undefined {
  return typeof slug === "string" && slug ? `https://polymarket.com/event/${slug}` : undefined;
}

function sideFromPrices(homeName: string, awayName: string, outcomes: unknown[], prices: unknown[]): PublicMarketSignal["side"] {
  const homeTokens = tokens(homeName);
  const awayTokens = tokens(awayName);
  let homePrice = -1;
  let awayPrice = -1;
  for (let i = 0; i < outcomes.length; i++) {
    const label = norm(String(outcomes[i] ?? ""));
    const price = Number(prices[i]);
    if (!Number.isFinite(price)) continue;
    if (homeTokens.some((t) => label.includes(t))) homePrice = Math.max(homePrice, price);
    if (awayTokens.some((t) => label.includes(t))) awayPrice = Math.max(awayPrice, price);
  }
  if (homePrice < 0 || awayPrice < 0 || Math.abs(homePrice - awayPrice) < 0.04) return null;
  return homePrice > awayPrice ? "home" : "away";
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

function pickMarket(events: unknown[], homeName: string, awayName: string): PublicMarketSignal {
  for (const evRaw of events) {
    if (!evRaw || typeof evRaw !== "object") continue;
    const ev = evRaw as Record<string, unknown>;
    const evText = `${ev.title ?? ""} ${ev.slug ?? ""}`;
    if (!exactishMatch(evText, homeName, awayName)) continue;
    for (const market of marketsOfEvent(ev)) {
      const q = String(market.question ?? market.title ?? "");
      if (!exactishMatch(`${q} ${market.slug ?? ""}`, homeName, awayName)) continue;
      const outcomes = parseJsonish(market.outcomes);
      const prices = parseJsonish(market.outcomePrices);
      return {
        status: "ok",
        source: "Polymarket",
        note: "命中 Polymarket 公开事件/市场",
        url: marketUrl(ev.slug ?? market.slug),
        side: sideFromPrices(homeName, awayName, outcomes, prices),
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

async function fetchEvents(query: string): Promise<unknown[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const url = `${GAMMA_EVENTS}?active=true&closed=false&limit=50&order=volume_24hr&ascending=false&search=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Polymarket ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function findPolymarketSignal(homeName: string, awayName: string): Promise<PublicMarketSignal> {
  const key = `poly:${norm(homeName)}:${norm(awayName)}`;
  return kvCached<PublicMarketSignal>(
    key,
    TTL_MS,
    async () => {
      try {
        const seen = new Set<string>();
        const queries = [`${homeName} ${awayName}`, homeName, awayName].filter((q) => {
          const n = norm(q);
          if (!n || seen.has(n)) return false;
          seen.add(n);
          return true;
        });
        const events = (await Promise.all(queries.map((q) => fetchEvents(q).catch(() => [] as unknown[])))).flat();
        return pickMarket(events, homeName, awayName);
      } catch {
        return { status: "error", source: "Polymarket", note: "Polymarket 公开接口暂不可用", capturedAt: Date.now() };
      }
    },
    { emptyTtlMs: TTL_MS },
  );
}
