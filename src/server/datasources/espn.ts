import { politeFetchText } from "./httpCache";
import { normName } from "./polymarket";
import type { NormalizedOdds } from "../engine/types";

/**
 * ESPN 隐藏 API（site.api.espn.com，零 key）：赛程/赛果/顺带 odds。
 * 用途：① 权威赛果（FT 后分钟级，直接结算，AI 双确认降为兜底）；② odds 书商维度（ESPN BET）。
 */

export const ESPN_LEAGUE_SLUG: Record<string, string> = {
  WC2026: "fifa.world",
  INT: "fifa.world",
  E0: "eng.1",
  E1: "eng.2",
  SP1: "esp.1",
  SP2: "esp.2",
  I1: "ita.1",
  I2: "ita.2",
  D1: "ger.1",
  D2: "ger.2",
  F1: "fra.1",
  F2: "fra.2",
  N1: "ned.1",
  P1: "por.1",
  B1: "bel.1",
  SC0: "sco.1",
  T1: "tur.1",
  G1: "gre.1",
};

export interface EspnEvent {
  homeName: string;
  awayName: string;
  /** 该队的全部可匹配名字（displayName/shortDisplayName/name/abbreviation） */
  homeKeys: string[];
  awayKeys: string[];
  kickoffAt: number;
  completed: boolean;
  homeScore: number | null;
  awayScore: number | null;
  odds: NormalizedOdds | null;
}

/** 美式赔率 → 十进制 */
export function americanToDecimal(a: number): number | null {
  if (!Number.isFinite(a) || a === 0) return null;
  const d = a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  return d >= 1.01 && d <= 60 ? d : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function teamKeys(t: Record<string, unknown>): string[] {
  return [str(t.displayName), str(t.shortDisplayName), str(t.name), str(t.abbreviation)].filter(Boolean);
}

function moneyLine(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const ml = Number((v as Record<string, unknown>).moneyLine ?? (v as Record<string, unknown>).value);
  return Number.isFinite(ml) ? ml : null;
}

/** scoreboard JSON → 事件列表（防御式） */
export function parseEspnScoreboard(text: string, capturedAt: number): EspnEvent[] {
  const out: EspnEvent[] = [];
  const json = JSON.parse(text) as { events?: unknown[] };
  for (const ev of json.events ?? []) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    const comp = (Array.isArray(e.competitions) ? e.competitions[0] : null) as Record<string, unknown> | null;
    if (!comp) continue;
    const competitors = (Array.isArray(comp.competitors) ? comp.competitors : []) as Record<string, unknown>[];
    const homeC = competitors.find((c) => c.homeAway === "home");
    const awayC = competitors.find((c) => c.homeAway === "away");
    if (!homeC || !awayC) continue;
    const homeTeam = (homeC.team ?? {}) as Record<string, unknown>;
    const awayTeam = (awayC.team ?? {}) as Record<string, unknown>;
    const kickoffAt = Date.parse(str(e.date));
    if (!Number.isFinite(kickoffAt)) continue;
    const status = (e.status ?? {}) as Record<string, unknown>;
    const completed = ((status.type ?? {}) as Record<string, unknown>).completed === true;
    const hs = Number(homeC.score);
    const as = Number(awayC.score);
    // odds（best-effort）：美式 moneyLine 三向 → 十进制
    let odds: NormalizedOdds | null = null;
    const oddsArr = (Array.isArray(comp.odds) ? comp.odds : []) as Record<string, unknown>[];
    const o = oddsArr[0];
    if (o) {
      const home = americanToDecimal(moneyLine(o.homeTeamOdds) ?? NaN);
      const away = americanToDecimal(moneyLine(o.awayTeamOdds) ?? NaN);
      const draw = americanToDecimal(moneyLine(o.drawOdds) ?? NaN);
      if (home && away && draw) {
        const sum = 1 / home + 1 / draw + 1 / away;
        if (sum >= 0.98 && sum <= 1.3) {
          const provider = ((o.provider ?? {}) as Record<string, unknown>).name;
          odds = { bookmaker: str(provider) || "ESPN BET", oneXTwo: { home, draw, away }, ou: [], ah: [], capturedAt };
        }
      }
    }
    out.push({
      homeName: str(homeTeam.displayName) || str(homeTeam.name),
      awayName: str(awayTeam.displayName) || str(awayTeam.name),
      homeKeys: teamKeys(homeTeam),
      awayKeys: teamKeys(awayTeam),
      kickoffAt,
      completed,
      homeScore: Number.isFinite(hs) ? hs : null,
      awayScore: Number.isFinite(as) ? as : null,
      odds,
    });
  }
  return out;
}

/** 事件 ↔ 比赛匹配：双队名 normName 互含 + 开球 ±3h */
export function matchEspnEvent(
  events: EspnEvent[],
  m: { homeNames: string[]; awayNames: string[]; kickoffAt: number },
): EspnEvent | null {
  const hk = m.homeNames.map(normName).filter(Boolean);
  const ak = m.awayNames.map(normName).filter(Boolean);
  const hits = (keys: string[], ours: string[]) =>
    keys.some((k) => {
      const n = normName(k);
      return n && ours.some((o) => o === n || n.includes(o) || o.includes(n));
    });
  return (
    events.find(
      (e) => Math.abs(e.kickoffAt - m.kickoffAt) <= 3 * 3_600_000 && hits(e.homeKeys, hk) && hits(e.awayKeys, ak),
    ) ?? null
  );
}

const UA = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
  accept: "application/json",
};

export async function fetchEspnScoreboard(slug: string, dateYYYYMMDD?: string, force = false): Promise<EspnEvent[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard${dateYYYYMMDD ? `?dates=${dateYYYYMMDD}` : ""}`;
  const { body } = await politeFetchText(url, force, UA);
  return parseEspnScoreboard(body, Date.now());
}
