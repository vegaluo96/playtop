import { shinDevig } from "./devig";
import type { NormalizedOdds, ThreeWay } from "./types";

/**
 * 多书商共识与最优价（纯函数）。
 * 共识 = 各家 Shin 去水后逐项中位数再归一（对单家坏报价稳健）；
 * 价值扫描用各 selection 跨家最优赔率（真实可成交口径）。
 * 单家时数学上退化为该家的 Shin 去水——与旧版行为完全一致。
 */

export interface BookDevig {
  bookmaker: string;
  rawOdds: ThreeWay;
  overround: number;
  shinZ: number;
  devigged: ThreeWay;
}

export function devigBooks(books: NormalizedOdds[]): BookDevig[] {
  const out: BookDevig[] = [];
  for (const b of books) {
    if (!b.oneXTwo) continue;
    const shin = shinDevig(b.oneXTwo);
    out.push({
      bookmaker: b.bookmaker ?? "未知来源",
      rawOdds: b.oneXTwo,
      overround: shin.overround,
      shinZ: shin.z,
      devigged: shin.probs,
    });
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function consensusProbs(devigged: BookDevig[]): ThreeWay | null {
  if (devigged.length === 0) return null;
  const m = {
    home: median(devigged.map((d) => d.devigged.home)),
    draw: median(devigged.map((d) => d.devigged.draw)),
    away: median(devigged.map((d) => d.devigged.away)),
  };
  const s = m.home + m.draw + m.away;
  return { home: m.home / s, draw: m.draw / s, away: m.away / s };
}

export interface BestPrice {
  odds: number;
  bookmaker: string;
}

export function bestOneXTwo(books: NormalizedOdds[]): { home: BestPrice; draw: BestPrice; away: BestPrice } | null {
  let out: { home: BestPrice; draw: BestPrice; away: BestPrice } | null = null;
  for (const b of books) {
    if (!b.oneXTwo) continue;
    const bm = b.bookmaker ?? "未知来源";
    if (!out) {
      out = {
        home: { odds: b.oneXTwo.home, bookmaker: bm },
        draw: { odds: b.oneXTwo.draw, bookmaker: bm },
        away: { odds: b.oneXTwo.away, bookmaker: bm },
      };
      continue;
    }
    for (const sel of ["home", "draw", "away"] as const) {
      if (b.oneXTwo[sel] > out[sel].odds) out[sel] = { odds: b.oneXTwo[sel], bookmaker: bm };
    }
  }
  return out;
}

/** 大小球：各家盘口线并集，每 (line, side) 取最优价 */
export function bestOu(books: NormalizedOdds[]): { line: number; over: BestPrice; under: BestPrice }[] {
  const byLine = new Map<number, { over: BestPrice; under: BestPrice }>();
  for (const b of books) {
    const bm = b.bookmaker ?? "未知来源";
    for (const o of b.ou) {
      const cur = byLine.get(o.line);
      if (!cur) {
        byLine.set(o.line, { over: { odds: o.over, bookmaker: bm }, under: { odds: o.under, bookmaker: bm } });
      } else {
        if (o.over > cur.over.odds) cur.over = { odds: o.over, bookmaker: bm };
        if (o.under > cur.under.odds) cur.under = { odds: o.under, bookmaker: bm };
      }
    }
  }
  return [...byLine.entries()]
    .map(([line, v]) => ({ line, ...v }))
    .sort((a, b) => a.line - b.line);
}

/** 亚盘：各家盘口线并集，每 (line, side) 取最优水位 */
export function bestAh(books: NormalizedOdds[]): { line: number; home: BestPrice; away: BestPrice }[] {
  const byLine = new Map<number, { home: BestPrice; away: BestPrice }>();
  for (const b of books) {
    const bm = b.bookmaker ?? "未知来源";
    for (const a of b.ah) {
      const cur = byLine.get(a.line);
      if (!cur) {
        byLine.set(a.line, { home: { odds: a.home, bookmaker: bm }, away: { odds: a.away, bookmaker: bm } });
      } else {
        if (a.home > cur.home.odds) cur.home = { odds: a.home, bookmaker: bm };
        if (a.away > cur.away.odds) cur.away = { odds: a.away, bookmaker: bm };
      }
    }
  }
  return [...byLine.entries()]
    .map(([line, v]) => ({ line, ...v }))
    .sort((a, b) => a.line - b.line);
}

/** 主参考大小球盘：优先最接近 2.5 的线，同线取两向水位最低（最公平）的一家报价 */
export function pickMainOu(books: NormalizedOdds[]): { line: number; over: number; under: number } | null {
  const candidates: { line: number; over: number; under: number; vig: number }[] = [];
  for (const b of books) {
    for (const o of b.ou) {
      candidates.push({ line: o.line, over: o.over, under: o.under, vig: 1 / o.over + 1 / o.under });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.line - 2.5) - Math.abs(b.line - 2.5) || a.vig - b.vig);
  const { line, over, under } = candidates[0];
  return { line, over, under };
}
