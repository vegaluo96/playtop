import { politeFetchText } from "./httpCache";
import { normName } from "./polymarket";
import { now } from "../lib/time";
import type { NormalizedOdds } from "../engine/types";

/**
 * 第二批盘口源（零 key）：
 * - Smarkets 交易所（真实盘锐价）：events → markets → quotes 三跳
 */

const UA = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0",
  accept: "application/json",
};

/* ---------------- Smarkets ---------------- */

interface SmarketsQuote {
  contractName: string;
  decimalOdds: number;
}

/** quotes 响应：价格为隐含概率万分数（best offer = 可买价），odds = 10000/price */
export function buildSmarketsQuotes(
  contractsText: string,
  quotesText: string,
): SmarketsQuote[] {
  const contracts = (JSON.parse(contractsText) as { contracts?: { id: string; name: string }[] }).contracts ?? [];
  const quotes = JSON.parse(quotesText) as Record<string, { offers?: { price: number }[] }>;
  const out: SmarketsQuote[] = [];
  for (const c of contracts) {
    const offers = quotes[c.id]?.offers ?? [];
    const best = offers.length ? Math.min(...offers.map((o) => o.price)) : null; // 最低价 = 最高赔率可买
    if (best && best > 0 && best < 10000) {
      const odds = 10000 / best;
      if (odds >= 1.01 && odds <= 60) out.push({ contractName: c.name, decimalOdds: odds });
    }
  }
  return out;
}

export function smarketsToOneXTwo(
  qs: SmarketsQuote[],
  match: { homeNames: string[]; awayNames: string[] },
  capturedAt: number,
): NormalizedOdds | null {
  const hk = match.homeNames.map(normName).filter(Boolean);
  const ak = match.awayNames.map(normName).filter(Boolean);
  let home: number | null = null;
  let draw: number | null = null;
  let away: number | null = null;
  for (const q of qs) {
    const key = normName(q.contractName);
    if (key === "draw" || key === "tie") draw = q.decimalOdds;
    else if (hk.some((k) => key.includes(k) || k.includes(key))) home = q.decimalOdds;
    else if (ak.some((k) => key.includes(k) || k.includes(key))) away = q.decimalOdds;
  }
  if (!home || !draw || !away) return null;
  const sum = 1 / home + 1 / draw + 1 / away;
  if (sum < 0.95 || sum > 1.2) return null;
  return { bookmaker: "Smarkets（交易所）", oneXTwo: { home, draw, away }, ou: [], ah: [], capturedAt };
}

export async function fetchSmarketsOdds(match: {
  homeNames: string[];
  awayNames: string[];
  kickoffAt: number;
}): Promise<NormalizedOdds | null> {
  // ① 事件发现
  const { body: evBody } = await politeFetchText(
    "https://api.smarkets.com/v3/events/?state=upcoming&type_domain=football&limit=200&sort=start_datetime",
    false,
    UA,
  );
  const events = (JSON.parse(evBody) as { events?: { id: string; name: string; start_datetime?: string }[] }).events ?? [];
  const hk = match.homeNames.map(normName).filter(Boolean);
  const ak = match.awayNames.map(normName).filter(Boolean);
  const ev = events.find((e) => {
    const t = e.start_datetime ? Date.parse(e.start_datetime) : NaN;
    if (Number.isFinite(t) && Math.abs(t - match.kickoffAt) > 6 * 3_600_000) return false;
    const hay = normName(e.name ?? "");
    return hk.some((k) => hay.includes(k)) && ak.some((k) => hay.includes(k));
  });
  if (!ev) return null;
  // ② 市场 → 取 Match Odds 类
  const { body: mkBody } = await politeFetchText(`https://api.smarkets.com/v3/events/${ev.id}/markets/`, false, UA);
  const markets = (JSON.parse(mkBody) as { markets?: { id: string; name: string }[] }).markets ?? [];
  const market = markets.find((m) => /match odds|winner|1x2/i.test(m.name ?? "")) ?? markets[0];
  if (!market) return null;
  // ③ 合约 + 报价
  const { body: ctBody } = await politeFetchText(`https://api.smarkets.com/v3/markets/${market.id}/contracts/`, false, UA);
  const { body: qBody } = await politeFetchText(`https://api.smarkets.com/v3/markets/${market.id}/quotes/`, false, UA);
  return smarketsToOneXTwo(buildSmarketsQuotes(ctBody, qBody), match, now());
}
