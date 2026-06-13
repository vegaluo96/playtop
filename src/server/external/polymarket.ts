import { kvCached, kvGet, kvSet } from "../af/store";
import { recordDiagnosticIssue, type DiagnosticSeverity } from "../af/diagnostics";
import type { PublicMarketSignal } from "../views/report-signals";

const GAMMA_SEARCH = "https://gamma-api.polymarket.com/public-search";
const TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 1800;
const MIN_EDGE = 0.04;
const AUTO_MATCH_SCORE = 74;
const REVIEW_MATCH_SCORE = 48;

type MarketType = NonNullable<PublicMarketSignal["marketType"]>;

interface Candidate {
  title: string;
  slug?: string;
  url?: string;
  marketType: MarketType;
  matchScore: number;
  reason: string;
  homeProb: number | null;
  drawProb: number | null;
  awayProb: number | null;
}

function recordPolyIssue(args: {
  fixtureId?: number | null;
  errorType: string;
  errorReason: string;
  severity?: DiagnosticSeverity;
  rawValue?: unknown;
  parsedValue?: unknown;
}): void {
  try {
    recordDiagnosticIssue({
      source: "POLYMARKET",
      endpoint: "polymarket.gamma",
      fixtureId: args.fixtureId ?? null,
      rawValue: args.rawValue,
      parsedValue: args.parsedValue,
      errorType: args.errorType,
      errorReason: args.errorReason,
      severity: args.severity ?? "info",
    });
  } catch {
    /* diagnostics must never break report generation */
  }
}

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

function aliasTokens(name: string): string[] {
  const base = tokens(name);
  const n = norm(name);
  const aliases: Record<string, string[]> = {
    "bosnia herzegovina": ["bosnia", "herzegovina", "bih"],
    "south korea": ["korea", "south", "republic korea"],
    "united states": ["usa", "america", "united", "states"],
    "usa": ["usa", "united", "states", "america"],
    "czechia": ["czech", "czechia"],
    "czech republic": ["czech", "czechia", "republic"],
  };
  return [...new Set([...base, ...(aliases[n] ?? [])].flatMap((x) => tokens(x).length ? tokens(x) : [norm(x)]).filter(Boolean))];
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
  const homeTokens = aliasTokens(homeName);
  const awayTokens = aliasTokens(awayName);
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
  const ht = aliasTokens(homeName);
  const at = aliasTokens(awayName);
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
  const homeTokens = aliasTokens(homeName);
  const awayTokens = aliasTokens(awayName);
  const hasHome = homeTokens.some((t) => text.includes(t));
  const hasAway = awayTokens.some((t) => text.includes(t));
  if (hasHome && !hasAway) return "home";
  if (hasAway && !hasHome) return "away";
  return null;
}

function marketTypeOf(text: string, exactMatch: boolean): MarketType {
  const hay = norm(text);
  if (/\b(advance|qualify|qualification|progress|reach next round)\b/.test(hay)) return "advancement";
  if (/\b(total goals|goals|over|under)\b/.test(hay)) return "totalGoals";
  if (/\b(champion|winner of|win the world cup|win world cup|tournament winner|outright)\b/.test(hay)) return "outright";
  if (exactMatch && /\b(win|winner|draw|tie|vs|versus)\b/.test(hay)) return "matchWinner";
  return exactMatch ? "matchWinner" : "unknown";
}

function candidateScore(args: { ev: Record<string, unknown>; homeName: string; awayName: string; marketType: MarketType; kickoffAt?: number | null; probs: { homeProb: number | null; drawProb: number | null; awayProb: number | null } }): { score: number; reason: string } {
  const text = norm(`${args.ev.title ?? ""} ${args.ev.slug ?? ""}`);
  const homeHits = aliasTokens(args.homeName).filter((t) => text.includes(t)).length;
  const awayHits = aliasTokens(args.awayName).filter((t) => text.includes(t)).length;
  let score = 0;
  const reasons: string[] = [];
  if (homeHits > 0) {
    score += Math.min(24, homeHits * 12);
    reasons.push("命中主队");
  }
  if (awayHits > 0) {
    score += Math.min(24, awayHits * 12);
    reasons.push("命中客队");
  }
  if (homeHits > 0 && awayHits > 0) {
    score += 22;
    reasons.push("同一事件命中双方");
  }
  if (/\b(soccer|football|fifa|world cup|match)\b/.test(text)) score += 8;
  if (args.kickoffAt) {
    const d = new Date(args.kickoffAt);
    const iso = d.toISOString().slice(0, 10);
    const compact = iso.replaceAll("-", " ");
    if (text.includes(norm(iso)) || text.includes(norm(compact)) || text.includes(iso.slice(5))) {
      score += 10;
      reasons.push("日期接近");
    }
  }
  if (args.marketType === "matchWinner") score += 16;
  if (args.marketType === "advancement") score -= 22;
  if (args.marketType === "outright") score -= 32;
  if (args.marketType === "totalGoals") score -= 18;
  if (args.probs.homeProb != null || args.probs.awayProb != null || args.probs.drawProb != null) {
    score += 12;
    reasons.push("outcome 可映射");
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), reason: reasons.join(" · ") || "低置信候选" };
}

function candidateOfEvent(ev: Record<string, unknown>, homeName: string, awayName: string, kickoffAt?: number | null): Candidate | null {
  if (closedOrInactive(ev)) return null;
  const evText = `${ev.title ?? ""} ${ev.slug ?? ""}`;
  const exact = exactishMatch(evText, homeName, awayName);
  const markets = marketsOfEvent(ev);
  const marketText = `${evText} ${markets.map((m) => `${m.question ?? ""} ${m.title ?? ""} ${m.groupItemTitle ?? ""}`).join(" ")}`;
  const marketType = marketTypeOf(marketText, exact);
  const binary = probsFromBinaryMarkets(markets, homeName, awayName);
  const multi = binary.homeProb != null || binary.awayProb != null || binary.drawProb != null ? binary : bestMultiOutcomeProbs(markets, homeName, awayName);
  const scored = candidateScore({ ev, homeName, awayName, marketType, kickoffAt, probs: multi });
  if (scored.score < 20 && !exact) return null;
  const title = String(ev.title ?? ev.slug ?? "Polymarket event");
  const slug = typeof ev.slug === "string" ? ev.slug : undefined;
  return {
    title,
    slug,
    url: marketUrl(slug),
    marketType,
    matchScore: scored.score,
    reason: scored.reason,
    homeProb: multi.homeProb,
    drawProb: multi.drawProb,
    awayProb: multi.awayProb,
  };
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

function publicCandidate(c: Candidate): NonNullable<PublicMarketSignal["candidates"]>[number] {
  return { title: c.title, slug: c.slug, url: c.url, marketType: c.marketType, matchScore: c.matchScore, reason: c.reason };
}

function pickMarket(events: unknown[], homeName: string, awayName: string, opts: { kickoffAt?: number | null; queries?: string[] } = {}): PublicMarketSignal {
  const candidates = events
    .map((evRaw) => {
      if (!evRaw || typeof evRaw !== "object") return null;
      return candidateOfEvent(evRaw as Record<string, unknown>, homeName, awayName, opts.kickoffAt);
    })
    .filter(Boolean)
    .sort((a, b) => b!.matchScore - a!.matchScore)
    .slice(0, 8) as Candidate[];
  const publicCandidates = candidates.map(publicCandidate);
  for (const c of candidates) {
    if (c.marketType !== "matchWinner") continue;
    const side = sideFromProb(c.homeProb, c.awayProb);
    if (c.matchScore >= AUTO_MATCH_SCORE && (c.homeProb != null || c.awayProb != null || c.drawProb != null)) {
      return {
        status: "ok",
        source: "Polymarket",
        note: "命中 Polymarket 单场预测市场",
        url: c.url,
        side,
        homeProb: c.homeProb,
        drawProb: c.drawProb,
        awayProb: c.awayProb,
        capturedAt: Date.now(),
        queries: opts.queries,
        matchScore: c.matchScore,
        marketType: c.marketType,
        selectedMarket: publicCandidate(c),
        candidates: publicCandidates,
        needsReview: false,
      };
    }
  }
  const review = candidates.find((c) => c.matchScore >= REVIEW_MATCH_SCORE);
  if (review) {
    return {
      status: "pendingReview",
      source: "Polymarket",
      note: review.marketType === "matchWinner" ? "候选市场置信度不足,等待人工确认" : "候选市场不是单场胜平负语义,等待人工确认",
      url: review.url,
      homeProb: review.homeProb,
      drawProb: review.drawProb,
      awayProb: review.awayProb,
      side: sideFromProb(review.homeProb, review.awayProb),
      capturedAt: Date.now(),
      queries: opts.queries,
      matchScore: review.matchScore,
      marketType: review.marketType,
      selectedMarket: publicCandidate(review),
      candidates: publicCandidates,
      needsReview: true,
    };
  }
  return {
    status: "missing",
    source: "Polymarket",
    note: "Polymarket 暂无本场可精确匹配的公开市场",
    capturedAt: Date.now(),
    queries: opts.queries,
    candidates: publicCandidates,
    needsReview: false,
  };
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

function polymarketKeys(homeName: string, awayName: string, fixtureId?: number | null): { key: string; legacyKey: string } {
  const legacyKey = `poly:${norm(homeName)}:${norm(awayName)}`;
  const key = fixtureId ? `poly:fx:${fixtureId}:${norm(homeName)}:${norm(awayName)}` : legacyKey;
  return { key, legacyKey };
}

export function readCachedPolymarketSignal(homeName: string, awayName: string, fixtureId?: number | null): PublicMarketSignal | null {
  const { key, legacyKey } = polymarketKeys(homeName, awayName, fixtureId);
  for (const k of [key, legacyKey]) {
    const raw = kvGet(k);
    if (!raw) continue;
    try {
      const cached = JSON.parse(raw) as { data?: PublicMarketSignal };
      if (cached.data) return cached.data;
    } catch {
      /* ignore malformed cache */
    }
  }
  return null;
}

export function writeConfirmedPolymarketSignal(homeName: string, awayName: string, fixtureId: number, signal: PublicMarketSignal): PublicMarketSignal {
  const { key } = polymarketKeys(homeName, awayName, fixtureId);
  const confirmed: PublicMarketSignal = {
    ...signal,
    status: "ok",
    note: "管理员已确认 Polymarket 候选市场",
    needsReview: false,
    capturedAt: Date.now(),
  };
  kvSet(key, JSON.stringify({ at: Date.now(), data: confirmed }));
  return confirmed;
}

function buildQueries(homeName: string, awayName: string, kickoffAt?: number | null): string[] {
  const day = kickoffAt ? new Date(kickoffAt).toISOString().slice(0, 10) : "";
  const pairs = [
    `${homeName} ${awayName}`,
    `${homeName} vs ${awayName}`,
    `${homeName} ${awayName} soccer`,
    `${homeName} ${awayName} football`,
    day ? `${homeName} ${awayName} ${day}` : "",
    homeName,
    awayName,
    ...aliasTokens(homeName).map((x) => `${x} ${awayName}`),
    ...aliasTokens(awayName).map((x) => `${homeName} ${x}`),
  ];
  const seen = new Set<string>();
  return pairs.filter((q) => {
    const n = norm(q);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  }).slice(0, 10);
}

export async function findPolymarketSignal(
  homeName: string,
  awayName: string,
  opts: { kickoffAt?: number | null; fixtureId?: number | null } = {},
): Promise<PublicMarketSignal> {
  const { key, legacyKey } = polymarketKeys(homeName, awayName, opts.fixtureId);
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
        const queries = buildQueries(homeName, awayName, opts.kickoffAt).filter((q) => {
          const n = norm(q);
          if (!n || seen.has(n)) return false;
          seen.add(n);
          return true;
        });
        const results = await Promise.all(
          queries.map(async (q) => {
            try {
              return { q, events: await searchEvents(q), error: null as string | null };
            } catch (e) {
              return { q, events: [] as unknown[], error: e instanceof Error ? e.message : String(e) };
            }
          }),
        );
        const errors = results.filter((r) => r.error);
        if (errors.length > 0) {
          recordPolyIssue({
            fixtureId: opts.fixtureId,
            errorType: "POLYMARKET_SEARCH_ERROR",
            errorReason: "Polymarket Gamma 搜索接口部分查询失败",
            severity: errors.length === results.length ? "error" : "warn",
            rawValue: errors.map((r) => ({ q: r.q, error: r.error })),
            parsedValue: { homeName, awayName },
          });
        }
        const events = results.flatMap((r) => r.events);
        const signal = pickMarket(events, homeName, awayName, { kickoffAt: opts.kickoffAt, queries });
        if (events.length === 0) {
          recordPolyIssue({
            fixtureId: opts.fixtureId,
            errorType: "POLYMARKET_EMPTY",
            errorReason: "Polymarket Gamma 搜索未返回相关公开事件",
            rawValue: { queries },
            parsedValue: { homeName, awayName },
          });
        } else if (signal.status === "missing") {
          recordPolyIssue({
            fixtureId: opts.fixtureId,
            errorType: "POLYMARKET_MATCH_MISS",
            errorReason: "Polymarket 有搜索结果,但没有高置信单场胜平负市场",
            rawValue: { queries, eventCount: events.length, candidates: signal.candidates },
            parsedValue: { homeName, awayName },
          });
        } else if (signal.status === "pendingReview") {
          recordPolyIssue({
            fixtureId: opts.fixtureId,
            errorType: "POLYMARKET_PENDING_REVIEW",
            errorReason: "Polymarket 候选市场需要人工确认后才能参与报告拟合",
            severity: "warn",
            rawValue: { queries, eventCount: events.length, candidates: signal.candidates },
            parsedValue: { homeName, awayName, selectedMarket: signal.selectedMarket, matchScore: signal.matchScore, marketType: signal.marketType },
          });
        }
        return signal;
      } catch (e) {
        recordPolyIssue({
          fixtureId: opts.fixtureId,
          errorType: "POLYMARKET_ERROR",
          errorReason: "Polymarket 公开接口暂不可用",
          severity: "error",
          rawValue: e instanceof Error ? e.message : String(e),
          parsedValue: { homeName, awayName },
        });
        return { status: "error", source: "Polymarket", note: "Polymarket 公开接口暂不可用", capturedAt: Date.now() };
      }
    },
    { emptyTtlMs: TTL_MS },
  );
}

export const __polymarketForTest = { pickMarket, buildQueries };
