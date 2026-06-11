import { describe, expect, it } from "vitest";
import { runEngine } from "@/server/engine";
import type { EngineBundle, EngineParams } from "@/server/engine/types";

const params: EngineParams = {
  rho: -0.05,
  bookWeights: {},
  sharpBooks: ["Pinnacle"],
  afWeight: 0.7,
  kellyFraction: 0.25,
  kellyCap: 0.05,
  evThreshold: 0.03,
  minProbForPick: 0.3,
  adjustmentsEnabled: true,
};

const T = Date.UTC(2026, 5, 11);

function bundleWith(books: EngineBundle["books"]): EngineBundle {
  return {
    match: { homeTeamId: 1, awayTeamId: 2, kickoffAt: T + 86_400_000 },
    books,
    computedAt: T,
  };
}

describe("价差监测：锐价真值锚 + 滞后偏离 + 失效指数", () => {
  it("有锐价时锚定锐价；软盘高报价方向被标为正偏离（滞后让利）", () => {
    const out = runEngine(
      bundleWith([
        { bookmaker: "Pinnacle", oneXTwo: { home: 2.0, draw: 3.5, away: 4.0 }, ou: [], ah: [], capturedAt: T },
        // 软盘主胜明显高于锐价口径 → 正偏离
        { bookmaker: "慢盘甲", oneXTwo: { home: 2.3, draw: 3.4, away: 3.8 }, ou: [], ah: [], capturedAt: T },
      ]),
      params,
    );
    expect(out.spread).not.toBeNull();
    expect(out.spread!.anchor.source).toBe("sharp");
    expect(out.spread!.anchor.books).toEqual(["Pinnacle"]);
    const top = out.spread!.deviations[0];
    expect(top.bookmaker).toBe("慢盘甲");
    expect(top.selection).toBe("home");
    expect(top.deviationPct).toBeGreaterThan(0.05);
    // 锚定概率自洽
    const p = out.spread!.anchor.probs;
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 6);
  });

  it("跨家最优组合隐含概率 <1 时标记定价失效现象", () => {
    const out = runEngine(
      bundleWith([
        { bookmaker: "Pinnacle", oneXTwo: { home: 2.2, draw: 3.6, away: 4.0 }, ou: [], ah: [], capturedAt: T },
        { bookmaker: "慢盘甲", oneXTwo: { home: 2.0, draw: 3.9, away: 4.6 }, ou: [], ah: [], capturedAt: T },
      ]),
      params,
    );
    // 最优价组合：2.2 / 3.9 / 4.6 → Σ1/odds ≈ 0.9285 < 1
    expect(out.spread!.inefficiencyIndex).not.toBeNull();
    expect(out.spread!.inefficiencyIndex!).toBeLessThan(1);
    expect(out.trace.some((t) => t.includes("定价失效"))).toBe(true);
  });

  it("无锐价时回落到加权共识锚；模拟盘不进偏离表", () => {
    const out = runEngine(
      bundleWith([
        { bookmaker: "慢盘甲", oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 }, ou: [], ah: [], capturedAt: T },
        { bookmaker: "参考盘", oneXTwo: { home: 2.6, draw: 3.2, away: 3.0 }, ou: [], ah: [], indicative: true, capturedAt: T },
      ]),
      params,
    );
    expect(out.spread!.anchor.source).toBe("consensus");
    expect(out.spread!.deviations.every((d) => d.bookmaker !== "参考盘")).toBe(true);
  });

  it("亚盘/大小球全线对锚偏离：亚盘排最前，模拟盘排除", () => {
    const out = runEngine(
      bundleWith([
        {
          bookmaker: "Pinnacle",
          oneXTwo: { home: 2.0, draw: 3.5, away: 4.0 },
          ou: [{ line: 2.5, over: 1.95, under: 1.95 }],
          ah: [{ line: -0.5, home: 1.95, away: 1.95 }],
          capturedAt: T,
        },
        {
          // 软盘：亚盘主队水位与大球水位都明显高于锐价口径 → 正偏离入榜
          bookmaker: "慢盘甲",
          oneXTwo: { home: 2.05, draw: 3.45, away: 3.95 },
          ou: [{ line: 2.5, over: 2.15, under: 1.78 }],
          ah: [{ line: -0.5, home: 2.12, away: 1.8 }],
          capturedAt: T,
        },
      ]),
      params,
    );
    const devs = out.spread!.deviations;
    expect(devs.length).toBeGreaterThan(0);
    // 展示顺序：亚盘 → 大小球 → 胜平负
    const order = devs.map((d) => d.market);
    expect(order[0]).toBe("ah");
    const firstOu = order.indexOf("ou");
    const first1x2 = order.indexOf("1x2");
    if (firstOu !== -1 && first1x2 !== -1) expect(firstOu).toBeLessThan(first1x2);
    // 亚盘主队让利方向被正确标出
    const ahDev = devs.find((d) => d.market === "ah" && d.selection === "home")!;
    expect(ahDev.bookmaker).toBe("慢盘甲");
    expect(ahDev.line).toBe(-0.5);
    expect(ahDev.deviationPct).toBeGreaterThan(0.05);
    // 大小球大球方向同理
    const ouDev = devs.find((d) => d.market === "ou" && d.selection === "over")!;
    expect(ouDev.deviationPct).toBeGreaterThan(0.05);
    expect(out.trace.some((t) => t.includes("亚盘") && t.includes("大小球"))).toBe(true);
  });

  it("无盘口时 spread 为 null", () => {
    const out = runEngine(bundleWith([]), params);
    expect(out.spread).toBeNull();
  });
});
