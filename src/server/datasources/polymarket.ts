import { politeFetchText } from "./httpCache";
import { now } from "../lib/time";
import type { NormalizedOdds } from "../engine/types";

/**
 * Polymarket Gamma 公开 API 适配器（零注册零 key）。
 * 预测市场价格即概率（≈无水），odds = 1/price；以 "Polymarket" 书商维度入快照。
 * 结构防御：递归扫描 JSON 找"像市场事件"的对象，兼容接口结构变动。
 */

const SEARCH_BASE = "https://gamma-api.polymarket.com/public-search";

export interface PolymarketEvent {
  title: string;
  /** 事件开始/比赛时间（毫秒），可能缺失 */
  startAt: number | null;
  /** 三向 moneyline 候选：outcome 标签 → 价格(0~1) */
  outcomes: { label: string; price: number }[];
}

/** 归一化名称：小写 + 去音调 + 去非字母数字（"Curaçao"→"curacao"） */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseTime(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 从一个"像市场"的对象抽取 outcomes（Gamma 的 outcomes/outcomePrices 是字符串化 JSON 数组） */
function extractOutcomes(o: Record<string, unknown>): { label: string; price: number }[] | null {
  try {
    const labels = typeof o.outcomes === "string" ? (JSON.parse(o.outcomes) as unknown) : o.outcomes;
    const prices = typeof o.outcomePrices === "string" ? (JSON.parse(o.outcomePrices) as unknown) : o.outcomePrices;
    if (!Array.isArray(labels) || !Array.isArray(prices) || labels.length !== prices.length) return null;
    const out: { label: string; price: number }[] = [];
    for (let i = 0; i < labels.length; i++) {
      const label = String(labels[i] ?? "").trim();
      const price = num(prices[i]);
      if (!label || price === null) return null;
      out.push({ label, price });
    }
    return out;
  } catch {
    return null;
  }
}

/** 递归扫描搜索响应，抽取全部事件（带标题/时间/三向 outcome 的市场） */
export function parsePolymarketSearch(text: string): PolymarketEvent[] {
  const out: PolymarketEvent[] = [];
  const walk = (node: unknown, inheritTitle: string, inheritStart: number | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritTitle, inheritStart);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const title = typeof o.title === "string" && o.title ? o.title : typeof o.question === "string" && o.question ? o.question : inheritTitle;
    const startAt =
      parseTime(o.gameStartTime) ?? parseTime(o.startDate) ?? parseTime(o.eventStartTime) ?? parseTime(o.endDate) ?? inheritStart;
    const outcomes = extractOutcomes(o);
    if (outcomes && outcomes.length >= 2 && title) {
      out.push({ title, startAt, outcomes });
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") walk(v, title, startAt);
    }
  };
  walk(JSON.parse(text), "", null);
  return out;
}

/**
 * 在候选事件中找指定比赛的三向 moneyline：
 * 标题/outcome 含两队名（归一化含匹配，支持别名），时间在开球 ±36h 内（缺失时间则仅靠名称）。
 */
export function pickEventForMatch(
  events: PolymarketEvent[],
  match: { homeNames: string[]; awayNames: string[]; kickoffAt: number },
): PolymarketEvent | null {
  const homeKeys = match.homeNames.map(normName).filter(Boolean);
  const awayKeys = match.awayNames.map(normName).filter(Boolean);
  const hits = events.filter((e) => {
    if (e.startAt !== null && Math.abs(e.startAt - match.kickoffAt) > 36 * 3_600_000) return false;
    const hay = normName(e.title + " " + e.outcomes.map((o) => o.label).join(" "));
    const hasHome = homeKeys.some((k) => hay.includes(k));
    const hasAway = awayKeys.some((k) => hay.includes(k));
    return hasHome && hasAway;
  });
  // 优先三向(含平局)市场、时间已知者
  hits.sort((a, b) => {
    const aDraw = a.outcomes.some((o) => normName(o.label) === "draw") ? 0 : 1;
    const bDraw = b.outcomes.some((o) => normName(o.label) === "draw") ? 0 : 1;
    if (aDraw !== bDraw) return aDraw - bDraw;
    return (a.startAt === null ? 1 : 0) - (b.startAt === null ? 1 : 0);
  });
  return hits[0] ?? null;
}

/** 事件 → 归一化盘口；找不到三向结构或价格不合理则拒收 */
export function buildOddsFromPolymarket(
  event: PolymarketEvent,
  match: { homeNames: string[]; awayNames: string[] },
  capturedAt: number,
): NormalizedOdds | null {
  const homeKeys = match.homeNames.map(normName).filter(Boolean);
  const awayKeys = match.awayNames.map(normName).filter(Boolean);
  let home: number | null = null;
  let draw: number | null = null;
  let away: number | null = null;
  for (const o of event.outcomes) {
    const key = normName(o.label);
    if (key === "draw" || key === "tie") draw = o.price;
    else if (homeKeys.some((k) => key.includes(k) || k.includes(key))) home = o.price;
    else if (awayKeys.some((k) => key.includes(k) || k.includes(key))) away = o.price;
  }
  if (home === null || draw === null || away === null) return null;
  const sum = home + draw + away;
  // 预测市场三向价格和应≈1；越界视为匹配错市场
  if (sum < 0.95 || sum > 1.08) return null;
  if ([home, draw, away].some((p) => p <= 0.01 || p >= 0.995)) return null;
  const toOdds = (p: number) => Math.min(60, Math.max(1.01, 1 / p));
  return {
    bookmaker: "Polymarket",
    oneXTwo: { home: toOdds(home), draw: toOdds(draw), away: toOdds(away) },
    ou: [],
    ah: [],
    capturedAt,
  };
}

/** 失败冷却（仿 oddsSync）：接口异常时 10 分钟内不再重试 */
let lastError: { at: number; msg: string } | null = null;

export async function fetchPolymarketOdds(match: {
  homeNames: string[];
  awayNames: string[];
  kickoffAt: number;
}): Promise<NormalizedOdds | null> {
  if (lastError && now() - lastError.at < 10 * 60_000) {
    throw new Error(`Polymarket 冷却中（上次失败：${lastError.msg}）`);
  }
  const q = encodeURIComponent(`${match.homeNames[0] ?? ""} ${match.awayNames[0] ?? ""}`.trim());
  const url = `${SEARCH_BASE}?q=${q}&limit_per_type=20`;
  try {
    const { body } = await politeFetchText(url, false);
    const events = parsePolymarketSearch(body);
    const event = pickEventForMatch(events, match);
    if (!event) return null;
    return buildOddsFromPolymarket(event, match, now());
  } catch (e) {
    if (!(e instanceof Error && /过于频繁/.test(e.message))) {
      lastError = { at: now(), msg: e instanceof Error ? e.message : String(e) };
    }
    throw e;
  }
}
