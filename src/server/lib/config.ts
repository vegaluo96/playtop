import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";
import { now } from "./time";

export const apiyiConfigSchema = z.object({
  baseUrl: z.string().default("https://api.apiyi.com/v1"),
  apiKey: z.string().default(""),
  /** 兼容字段：三类模型未单独配置时的缺省 */
  model: z.string().default("gpt-4o"),
  /** 按任务路由：检索（需联网搜索）/ 写作（专业长文）/ 快速（校验类）；留空回落到 model */
  models: z
    .object({
      retrieval: z.string().default(""),
      writing: z.string().default(""),
      fast: z.string().default(""),
    })
    .default({ retrieval: "", writing: "", fast: "" }),
  temperature: z.number().min(0).max(2).default(0.3),
});
export type ApiyiConfig = z.infer<typeof apiyiConfigSchema>;
export type LlmTask = "retrieval" | "writing" | "fast";

export const datasourcesConfigSchema = z.object({
  /** football-data.co.uk 联赛代码，如 E0(英超) SP1(西甲) I1(意甲) D1(德甲) F1(法甲) */
  enabledLeagues: z.array(z.string()).default(["E0", "SP1", "I1", "D1", "F1"]),
  csvBase: z.string().default("https://www.football-data.co.uk"),
  aiRetrievalEnabled: z.boolean().default(true),
  /** eloratings.net 国家队 Elo（世界杯外部评级维度） */
  eloRatingsEnabled: z.boolean().default(true),
  /** api.clubelo.com 俱乐部 Elo（联赛外部评级维度） */
  clubEloEnabled: z.boolean().default(true),
  /** martj42 GitHub 数据集：国际赛射手榜/点球大战史 */
  githubIntlEnabled: z.boolean().default(true),
  /** API-Football 付费主源（盘口/首发/伤停/赛果）；key 未配置时自动缺席 */
  apiFootballEnabled: z.boolean().default(true),
  /** API-Football key：后台填写优先；留空回落到服务器 env API_FOOTBALL_KEY */
  apiFootballKey: z.string().default(""),
  /** 数据源连败 N 次自动停用（体检成功自动复活）；0 = 不自动停用 */
  sourceAutoDisableAfter: z.number().min(0).default(5),
});
export type DatasourcesConfig = z.infer<typeof datasourcesConfigSchema>;

/** 全自动流水线开关：全开 = 建模→发布→改版→赛果→结算零人工；可逐项降级回人工 */
export const automationConfigSchema = z.object({
  autoCollect: z.boolean().default(true),
  /** ready → 自动运行引擎建模 */
  autoAnalyze: z.boolean().default(true),
  /** analyzed → 自动按默认积分价发布首版 */
  autoPublish: z.boolean().default(true),
  /** 距开球 N 小时内仍无盘口 → 强制进 ready（引擎走无市场退化链）；0 = 关闭兜底 */
  readyWithoutOddsHours: z.number().min(0).default(48),
  /** 自动流水线处理窗口：开球前 N 小时进入采集→建模→发布管道 */
  pipelineWindowHours: z.number().min(1).default(48),
  /** AI 检索赛果自动确认并结算（安全栏见 policy） */
  autoConfirmAiResults: z.boolean().default(true),
  /** double_check：两次独立检索同比分才确认；delay：录入后等 N 小时无人纠正即确认 */
  aiResultConfirmPolicy: z.enum(["double_check", "delay"]).default("double_check"),
  aiResultConfirmDelayHours: z.number().min(1).default(6),
});
export type AutomationConfig = z.infer<typeof automationConfigSchema>;

export const engineConfigSchema = z.object({
  /** Dixon-Coles 时间衰减（每天），论文 ξ=0.0065/半周 ≈ 0.0019/天 */
  xi: z.number().default(0.0019),
  /** 低比分相关性 ρ 的缺省/退化值 */
  rho: z.number().default(-0.05),
  homeAdvElo: z.number().default(100),
  eloK0: z.number().default(10),
  eloGoalDiffExp: z.number().default(1),
  /** 有序 logit（Elo 差→三向概率）系数，文献典型值；积累样本后可重拟合覆盖 */
  eloCalib: z
    .object({ b: z.number(), c1: z.number(), c2: z.number() })
    .default({ b: 0.0044, c1: -0.45, c2: 0.55 }),
  /**
   * 对数意见池权重（自动按缺席模型重归一）。
   * 缺省偏重市场：去水收盘价是文献公认最强基线（Štrumbelj 2014），
   * 统计模型的职责是提供独立视角与比分分布，而非压过市场。
   */
  ensembleWeights: z
    .object({ market: z.number(), dc: z.number(), elo: z.number() })
    .default({ market: 0.55, dc: 0.3, elo: 0.15 }),
  /**
   * 书商因子权重（加权共识用）：锐盘（交易所/Pinnacle）高权，官方彩票/综合价中权，
   * 模拟盘低权。未列出的书商默认 1；离群报价引擎自动再降权 80%。
   */
  bookWeights: z
    .record(z.string(), z.number())
    .default({
      Pinnacle: 1.3,
      bet365: 1.2,
      "皇冠（Crown）": 1.1,
      威廉希尔: 1.1,
      "football-data.co.uk 综合": 1.0,
      人工录入: 1.0,
    }),
  /** 锐价真值锚（硬庄口径）：单独去水做市场真值，驱动价差监测/滞后偏离 */
  sharpBooks: z.array(z.string()).default(["Pinnacle"]),
  /** 射门质量混合系数 θ（Wheatcroft 2020），0 关闭 */
  shotsBlendTheta: z.number().min(0).max(1).default(0.35),
  /** xG 融合系数 θ_xg（近期 xG 推算期望进球与 DC 估计融合），0 关闭 */
  xgBlend: z.number().min(0).max(1).default(0.3),
  /** AF 蒸馏预测权重 w_af：AF 用全量库蒸馏优于自建模型，存在时主导集成（市场做对照）。缺 AF 时自动回落自建链路 */
  afWeight: z.number().min(0).max(1).default(0.7),
  kellyFraction: z.number().default(0.25),
  kellyCap: z.number().default(0.05),
  /** EV 超过该阈值才标记价值偏差/生成 pick */
  evThreshold: z.number().default(0.03),
  /** pick 的最低模型概率（太小概率的"价值"多为噪声） */
  minProbForPick: z.number().default(0.3),
  /**
   * 最低可接受赔率安全垫：边界价 = margin / 模型概率。
   * 观点发布时印出这条静态边界线（玩家拿自己平台的实时价自行对照）；
   * 开赛锁定时收盘价低于边界 → 该观点按观望处理不进战绩。0 = 关闭边界机制。
   */
  boundaryMargin: z.number().min(0).default(1.02),
  adjustmentsEnabled: z.boolean().default(true),
});
export type EngineConfig = z.infer<typeof engineConfigSchema>;

export const pricingConfigSchema = z.object({
  defaultPricePoints: z.number().int().min(0).default(10),
  /** 免费公测：全部赛前观点免费公开（冷启动先攒可验战绩）；战绩起量后关闭即恢复积分解锁 */
  freeBeta: z.boolean().default(true),
});
export type PricingConfig = z.infer<typeof pricingConfigSchema>;

const CONFIG_SCHEMAS = {
  apiyi: apiyiConfigSchema,
  datasources: datasourcesConfigSchema,
  engine: engineConfigSchema,
  pricing: pricingConfigSchema,
  automation: automationConfigSchema,
} as const;
export type ConfigKey = keyof typeof CONFIG_SCHEMAS;

export function getConfig<K extends ConfigKey>(key: K): z.infer<(typeof CONFIG_SCHEMAS)[K]> {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  const raw = row ? JSON.parse(row.value) : {};
  return CONFIG_SCHEMAS[key].parse(raw) as z.infer<(typeof CONFIG_SCHEMAS)[K]>;
}

export function setConfig<K extends ConfigKey>(key: K, value: unknown): z.infer<(typeof CONFIG_SCHEMAS)[K]> {
  const parsed = CONFIG_SCHEMAS[key].parse(value);
  db.insert(settings)
    .values({ key, value: JSON.stringify(parsed), updatedAt: now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(parsed), updatedAt: now() },
    })
    .run();
  return parsed as z.infer<(typeof CONFIG_SCHEMAS)[K]>;
}
