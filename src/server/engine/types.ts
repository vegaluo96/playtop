import { z } from "zod";

export const ENGINE_MODEL_VERSION = "engine-1.2.0";

/** 三向概率/赔率 */
export const threeWaySchema = z.object({
  home: z.number(),
  draw: z.number(),
  away: z.number(),
});
export type ThreeWay = z.infer<typeof threeWaySchema>;

/** 归一化赔率快照（odds kind 的 payload） */
export const normalizedOddsSchema = z.object({
  bookmaker: z.string().optional(),
  oneXTwo: threeWaySchema.optional(),
  /** 大小球：line 如 2.5 */
  ou: z.array(z.object({ line: z.number(), over: z.number(), under: z.number() })).default([]),
  /** 亚盘：line 为主队让球（主让半球 = -0.5） */
  ah: z.array(z.object({ line: z.number(), home: z.number(), away: z.number() })).default([]),
  /** 让球胜平负（竞彩口径：整数让球的三向盘，非亚盘），line 为主队让球数 */
  hhad: z.object({ line: z.number(), home: z.number(), draw: z.number(), away: z.number() }).optional(),
  /** 总进球数赔率：键为 "0".."6" 与 "7+" */
  totalGoals: z.record(z.string(), z.number()).optional(),
  /** 波胆/正确比分赔率（"主:客" 格式） */
  correctScores: z.array(z.object({ score: z.string(), odds: z.number() })).optional(),
  /** 参考盘（模拟盘/不可成交）：进共识但不进最优价/价值/Kelly 口径 */
  indicative: z.boolean().optional(),
  capturedAt: z.number(),
});
export type NormalizedOdds = z.infer<typeof normalizedOddsSchema>;

/** 历史比赛（DC 拟合 / Elo 回放输入）；射门数据用于射门质量评分（可缺省） */
export interface HistMatch {
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  playedAt: number;
  /** 中立场（国际大赛常见）：该场不计主场优势 γ */
  neutral?: boolean;
  homeShots?: number;
  homeSot?: number;
  awayShots?: number;
  awaySot?: number;
}

export interface InjuryItem {
  team: "home" | "away";
  player: string;
  role: "goalkeeper" | "defender" | "midfielder" | "attacker" | "unknown";
  importance: "key" | "regular" | "fringe";
  status: string;
}

export interface WeatherInfo {
  temperatureC?: number;
  precipitationMmH?: number;
  windKmH?: number;
  summary?: string;
}

export interface EngineParams {
  xi: number;
  rho: number;
  homeAdvElo: number;
  eloK0: number;
  eloGoalDiffExp: number;
  eloCalib: { b: number; c1: number; c2: number };
  ensembleWeights: { market: number; dc: number; elo: number };
  /** 书商权重（量化因子口径）：加权共识用；未列出的书商权重 1，离群报价自动降权 */
  bookWeights: Record<string, number>;
  /** 锐价真值锚书商（硬庄口径）：单独去水做"市场真值"，用于价差监测/滞后偏离 */
  sharpBooks: string[];
  kellyFraction: number;
  kellyCap: number;
  evThreshold: number;
  minProbForPick: number;
  adjustmentsEnabled: boolean;
  /**
   * 射门质量混合系数 θ∈[0,1]：进球是高噪声信号，射门/射正更稳定
   * （Wheatcroft 2020，shots-based ratings 对大小球市场显著优于纯进球）。
   * 0 = 纯进球；历史数据缺射门列时自动退回纯进球。
   */
  shotsBlendTheta: number;
}

/** runEngine 的输入包：全部来自数据快照与本地库，引擎本身零 IO、无时钟 */
export interface EngineBundle {
  match: {
    homeTeamId: number;
    awayTeamId: number;
    kickoffAt: number;
    neutralVenue?: boolean;
  };
  odds?: NormalizedOdds;
  /** 多家书商各自最新盘口（缺省时回落到 odds 单家）；引擎内做共识与最优价 */
  books?: NormalizedOdds[];
  oddsSeries?: NormalizedOdds[];
  injuries?: InjuryItem[];
  weather?: WeatherInfo;
  leagueHistory: HistMatch[];
  elo?: {
    home: { rating: number; matchesPlayed: number };
    away: { rating: number; matchesPlayed: number };
  };
  computedAt: number;
}

/** DC 退化等级：1=完整MLE 2=矩估计 3=市场反推 4=纯市场 */
export type FallbackLevel = 1 | 2 | 3 | 4;

export const engineOutputSchema = z.object({
  modelVersion: z.string(),
  computedAt: z.number(),
  fallbackLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  market: z
    .object({
      /** 主参考家（水位最低=最锐）的原始赔率与去水参数 */
      rawOdds: threeWaySchema,
      overround: z.number(),
      shinZ: z.number(),
      /** 多家共识概率（各家 Shin 去水后逐项中位数归一；单家时即该家去水） */
      devigged: threeWaySchema,
      /** 每家明细（旧版输出无此字段 → 默认空数组，向后兼容） */
      books: z
        .array(
          z.object({
            bookmaker: z.string(),
            rawOdds: threeWaySchema,
            overround: z.number(),
            shinZ: z.number(),
            devigged: threeWaySchema,
          }),
        )
        .default([]),
    })
    .nullable(),
  dixonColes: z
    .object({
      lambda: z.number(),
      mu: z.number(),
      rho: z.number(),
      gamma: z.number(),
      probs: threeWaySchema,
      /** P[homeGoals][awayGoals]，0..10 截断（集成重标定后的最终矩阵） */
      scoreMatrix: z.array(z.array(z.number())),
      topScores: z.array(z.object({ score: z.string(), prob: z.number() })),
    })
    .nullable(),
  elo: z
    .object({
      home: z.number(),
      away: z.number(),
      diff: z.number(),
      probs: threeWaySchema,
    })
    .nullable(),
  adjustments: z.array(
    z.object({
      reason: z.string(),
      lambdaFactor: z.number(),
      muFactor: z.number(),
    }),
  ),
  ensemble: z.object({
    weights: z.object({ market: z.number(), dc: z.number(), elo: z.number() }),
    probs: threeWaySchema,
  }),
  markets: z.object({
    ou: z.array(z.object({ line: z.number(), over: z.number(), under: z.number() })),
    /** 主队覆盖（赢盘）概率，已含 push 折算 */
    ah: z.array(z.object({ line: z.number(), homeCover: z.number(), awayCover: z.number() })),
  }),
  /** 比分市场对照：波胆赔率 power 去水 vs 模型比分分布（旧版输出无此字段） */
  scoreMarket: z
    .array(
      z.object({
        score: z.string(),
        marketProb: z.number(),
        modelProb: z.number(),
        odds: z.number(),
        bookmaker: z.string(),
      }),
    )
    .default([]),
  value: z.array(
    z.object({
      market: z.enum(["1x2", "ou", "ah"]),
      selection: z.string(),
      line: z.number().nullable(),
      odds: z.number(),
      /** 该最优价出自哪家书商（旧版输出无此字段） */
      bookmaker: z.string().optional(),
      modelProb: z.number(),
      ev: z.number(),
      kelly: z.number(),
    }),
  ),
  picks: z.array(
    z.object({
      market: z.enum(["1x2", "ou", "ah"]),
      selection: z.string(),
      line: z.number().nullable(),
      modelProb: z.number(),
      odds: z.number().nullable(),
      bookmaker: z.string().optional(),
      ev: z.number().nullable(),
      kelly: z.number().nullable(),
      confidence: z.enum(["A", "B", "C"]),
    }),
  ),
  oddsMovement: z
    .array(
      z.object({
        capturedAt: z.number(),
        oneXTwo: threeWaySchema.nullable(),
        bookmaker: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * 价差监测（玩家动线第④步："这个价相对真值贵还是便宜"）：
   * 锐价子集（硬庄）单独去水做真值锚；各家报价对锚的偏离即"滞后让利"研究信号；
   * 失效指数 = Σ(1/各方向跨家最优价)，<1 即市场出现定价失效现象。旧版输出无此字段。
   */
  spread: z
    .object({
      anchor: z.object({ source: z.enum(["sharp", "consensus"]), books: z.array(z.string()), probs: threeWaySchema }),
      deviations: z.array(
        z.object({
          bookmaker: z.string(),
          market: z.enum(["1x2", "ah", "ou"]).default("1x2"),
          line: z.number().nullable().default(null),
          selection: z.enum(["home", "draw", "away", "over", "under"]),
          odds: z.number(),
          fairOdds: z.number(),
          /** 报价相对锚定公允价的偏离（正 = 高于公允 = 滞后让利方向） */
          deviationPct: z.number(),
        }),
      ),
      inefficiencyIndex: z.number().nullable(),
    })
    .nullable()
    .default(null),
  trace: z.array(z.string()),
});
export type EngineOutput = z.infer<typeof engineOutputSchema>;
