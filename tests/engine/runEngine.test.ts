import { describe, expect, it } from "vitest";
import { runEngine } from "@/server/engine";
import { engineOutputSchema, type EngineBundle, type EngineParams } from "@/server/engine/types";

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

const odds = {
  oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 },
  ou: [{ line: 2.5, over: 1.95, under: 1.95 }],
  ah: [{ line: -0.25, home: 1.98, away: 1.92 }],
  capturedAt: Date.UTC(2026, 5, 1),
};

const af = { home: 0.55, draw: 0.27, away: 0.18, expGoalsHome: 1.8, expGoalsAway: 1.05, advice: "Winner: Home" };

const T = Date.UTC(2026, 5, 1);

describe("runEngine 集成（AF 蒸馏 + 市场，自建统计已移除）", () => {
  const computedAt = T;

  it("AF 预测 + 盘口 → 等级 1，输出通过 schema 校验，概率自洽，矩阵边际与集成一致", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 100, awayTeamId: 101, kickoffAt: computedAt + 86_400_000 },
      odds,
      afPrediction: af,
      computedAt,
    };
    const out = runEngine(bundle, params);
    expect(engineOutputSchema.parse(out)).toBeTruthy();
    expect(out.fallbackLevel).toBe(1);
    expect(out.afModel).not.toBeNull();
    expect(out.elo).toBeNull();
    const e = out.ensemble.probs;
    expect(e.home + e.draw + e.away).toBeCloseTo(1, 6);
    expect(out.market!.overround).toBeGreaterThan(0);
    // 比分矩阵边际（整体重标定后）与集成概率一致
    let home = 0;
    for (let x = 0; x < out.dixonColes!.scoreMatrix.length; x++) {
      for (let y = 0; y < out.dixonColes!.scoreMatrix[x].length; y++) {
        if (x > y) home += out.dixonColes!.scoreMatrix[x][y];
      }
    }
    expect(home).toBeCloseTo(e.home, 6);
    expect(out.markets.ou.length).toBeGreaterThan(0);
    expect(out.markets.ah.length).toBe(1);
    expect(out.trace.length).toBeGreaterThan(5);
    // 确定性：同输入两次运行结果一致
    const out2 = runEngine(bundle, params);
    expect(JSON.stringify(out2)).toBe(JSON.stringify(out));
  });

  it("无 AF + 有盘口 → 等级 3（市场反推），集成 ≈ 市场去水", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 900, awayTeamId: 901, kickoffAt: computedAt },
      odds,
      computedAt,
    };
    const out = runEngine(bundle, params);
    expect(out.fallbackLevel).toBe(3);
    expect(out.afModel).toBeNull();
    expect(out.dixonColes).not.toBeNull();
    // 市场反推下集成 ≈ 市场去水概率
    expect(out.ensemble.probs.home).toBeCloseTo(out.market!.devigged.home, 1);
  });

  it("无 AF 无盘口 → 等级 4，无矩阵无 picks", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 900, awayTeamId: 901, kickoffAt: computedAt },
      computedAt,
    };
    const out = runEngine(bundle, params);
    expect(out.fallbackLevel).toBe(4);
    expect(out.dixonColes).toBeNull();
    expect(out.picks).toHaveLength(0);
  });

  it("伤停与恶劣天气修正进入 trace 且有界", () => {
    const bundle: EngineBundle = {
      match: { homeTeamId: 100, awayTeamId: 101, kickoffAt: computedAt },
      odds,
      afPrediction: af,
      injuries: [
        { team: "home", player: "九号位", role: "attacker", importance: "key", status: "伤" },
        { team: "home", player: "中卫", role: "defender", importance: "key", status: "停赛" },
      ],
      weather: { precipitationMmH: 8, windKmH: 20 },
      computedAt,
    };
    const out = runEngine(bundle, params);
    expect(out.adjustments.length).toBeGreaterThanOrEqual(3);
    const product = out.adjustments.reduce((s, a) => s * a.lambdaFactor, 1);
    expect(product).toBeGreaterThan(0.8);
    expect(product).toBeLessThan(1.1);
  });
});

describe("多书商与比分市场", () => {
  const base = {
    match: { homeTeamId: 100, awayTeamId: 101, kickoffAt: T + 86_400_000 },
    computedAt: T,
  };

  it("books 多家：market.books 逐家产出，价值行取跨家最优价并带书商", () => {
    const bundle: EngineBundle = {
      ...base,
      books: [
        { bookmaker: "bet365", oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 }, ou: [], ah: [], capturedAt: 1 },
        { bookmaker: "Polymarket", oneXTwo: { home: 2.2, draw: 3.3, away: 3.5 }, ou: [], ah: [], capturedAt: 2 },
      ],
    };
    const out = runEngine(bundle, params);
    expect(out.market!.books).toHaveLength(2);
    const home = out.value.find((v) => v.market === "1x2" && v.selection === "home")!;
    expect(home.odds).toBe(2.2);
    expect(home.bookmaker).toBe("Polymarket");
    // 确定性：同输入同输出
    expect(JSON.stringify(runEngine(bundle, params))).toBe(JSON.stringify(out));
  });

  it("波胆赔率 → scoreMarket 对照（市场概率归一、模型概率出自比分矩阵）", () => {
    const correctScores = [
      { score: "1:0", odds: 7.0 },
      { score: "0:0", odds: 9.0 },
      { score: "1:1", odds: 6.0 },
      { score: "2:1", odds: 9.0 },
      { score: "0:1", odds: 9.5 },
      { score: "2:0", odds: 12.0 },
      { score: "0:2", odds: 15.0 },
      { score: "2:2", odds: 14.0 },
    ];
    const bundle: EngineBundle = {
      ...base,
      books: [
        {
          bookmaker: "中国竞彩（官方）",
          oneXTwo: { home: 2.1, draw: 3.4, away: 3.6 },
          ou: [],
          ah: [],
          correctScores,
          capturedAt: 1,
        },
      ],
    };
    const out = runEngine(bundle, params);
    expect(out.scoreMarket).toHaveLength(8);
    const sum = out.scoreMarket.reduce((a, s) => a + s.marketProb, 0);
    expect(sum).toBeGreaterThan(0.95);
    expect(sum).toBeLessThanOrEqual(1.000001);
    for (const s of out.scoreMarket) {
      expect(s.modelProb).toBeGreaterThan(0);
      expect(s.bookmaker).toBe("中国竞彩（官方）");
    }
    // 旧输出（无 scoreMarket 字段）仍可被 schema 解析
    const legacy = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    delete legacy.scoreMarket;
    expect(engineOutputSchema.parse(legacy).scoreMarket).toEqual([]);
  });
});
