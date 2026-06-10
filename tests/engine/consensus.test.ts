import { describe, expect, it } from "vitest";

import { bestAh, bestOneXTwo, bestOu, consensusProbs, devigBooks, pickMainOu } from "@/server/engine/consensus";
import { shinDevig } from "@/server/engine/devig";
import type { NormalizedOdds } from "@/server/engine/types";

const book = (bookmaker: string, oneXTwo: { home: number; draw: number; away: number }, extra?: Partial<NormalizedOdds>): NormalizedOdds => ({
  bookmaker,
  oneXTwo,
  ou: [],
  ah: [],
  capturedAt: 0,
  ...extra,
});

describe("多书商共识与最优价", () => {
  const b365 = book("bet365", { home: 1.65, draw: 3.9, away: 5.5 });
  const crown = book("皇冠", { home: 1.7, draw: 3.8, away: 5.2 });
  const poly = book("Polymarket", { home: 1.72, draw: 4.0, away: 5.4 });

  it("单家共识 ≡ 该家 Shin 去水（旧行为连续性）", () => {
    const devigs = devigBooks([b365]);
    const consensus = consensusProbs(devigs)!;
    const shin = shinDevig(b365.oneXTwo!);
    expect(consensus.home).toBeCloseTo(shin.probs.home, 10);
    expect(consensus.draw).toBeCloseTo(shin.probs.draw, 10);
    expect(consensus.away).toBeCloseTo(shin.probs.away, 10);
  });

  it("三家共识 = 逐项中位数再归一，且概率和为 1", () => {
    const devigs = devigBooks([b365, crown, poly]);
    const consensus = consensusProbs(devigs)!;
    const sum = consensus.home + consensus.draw + consensus.away;
    expect(sum).toBeCloseTo(1, 10);
    // 中位数稳健性：单家极端报价不应把共识拉走太多
    const withBad = devigBooks([b365, crown, book("坏报价", { home: 1.05, draw: 15, away: 30 })]);
    const c2 = consensusProbs(withBad)!;
    expect(Math.abs(c2.home - consensus.home)).toBeLessThan(0.08);
  });

  it("跨家最优价：每方向取最高赔率并标注书商", () => {
    const best = bestOneXTwo([b365, crown, poly])!;
    expect(best.home).toEqual({ odds: 1.72, bookmaker: "Polymarket" });
    expect(best.draw).toEqual({ odds: 4.0, bookmaker: "Polymarket" });
    expect(best.away).toEqual({ odds: 5.5, bookmaker: "bet365" });
  });

  it("大小球/亚盘：盘口线并集，每 (line, side) 最优", () => {
    const a = book("A", { home: 2, draw: 3, away: 4 }, { ou: [{ line: 2.5, over: 1.9, under: 1.92 }], ah: [{ line: -0.5, home: 1.85, away: 1.97 }] });
    const b = book("B", { home: 2, draw: 3, away: 4 }, { ou: [{ line: 2.5, over: 1.95, under: 1.88 }, { line: 3, over: 2.3, under: 1.62 }] });
    const ou = bestOu([a, b]);
    expect(ou).toHaveLength(2);
    expect(ou[0]).toEqual({ line: 2.5, over: { odds: 1.95, bookmaker: "B" }, under: { odds: 1.92, bookmaker: "A" } });
    expect(ou[1].line).toBe(3);
    const ah = bestAh([a, b]);
    expect(ah).toHaveLength(1);
    expect(ah[0].home.bookmaker).toBe("A");
  });

  it("主参考大小球盘：最接近 2.5 优先，同线取水位最低", () => {
    const a = book("A", { home: 2, draw: 3, away: 4 }, { ou: [{ line: 2.5, over: 1.85, under: 1.85 }] }); // 高水
    const b = book("B", { home: 2, draw: 3, away: 4 }, { ou: [{ line: 2.5, over: 1.95, under: 1.95 }] }); // 低水
    const main = pickMainOu([a, b])!;
    expect(main.over).toBe(1.95);
  });
});
