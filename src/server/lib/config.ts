import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";
import { now } from "./time";

export const apiyiConfigSchema = z.object({
  baseUrl: z.string().default("https://api.apiyi.com/v1"),
  apiKey: z.string().default(""),
  model: z.string().default("gpt-4o"),
  temperature: z.number().min(0).max(2).default(0.3),
});
export type ApiyiConfig = z.infer<typeof apiyiConfigSchema>;

export const datasourcesConfigSchema = z.object({
  /** football-data.co.uk 联赛代码，如 E0(英超) SP1(西甲) I1(意甲) D1(德甲) F1(法甲) */
  enabledLeagues: z.array(z.string()).default(["E0", "SP1", "I1", "D1", "F1"]),
  csvBase: z.string().default("https://www.football-data.co.uk"),
  aiRetrievalEnabled: z.boolean().default(true),
});
export type DatasourcesConfig = z.infer<typeof datasourcesConfigSchema>;

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
  /** 射门质量混合系数 θ（Wheatcroft 2020），0 关闭 */
  shotsBlendTheta: z.number().min(0).max(1).default(0.35),
  kellyFraction: z.number().default(0.25),
  kellyCap: z.number().default(0.05),
  /** EV 超过该阈值才标记价值偏差/生成 pick */
  evThreshold: z.number().default(0.03),
  /** pick 的最低模型概率（太小概率的"价值"多为噪声） */
  minProbForPick: z.number().default(0.3),
  adjustmentsEnabled: z.boolean().default(true),
});
export type EngineConfig = z.infer<typeof engineConfigSchema>;

export const pricingConfigSchema = z.object({
  defaultPricePoints: z.number().int().min(0).default(10),
});
export type PricingConfig = z.infer<typeof pricingConfigSchema>;

const CONFIG_SCHEMAS = {
  apiyi: apiyiConfigSchema,
  datasources: datasourcesConfigSchema,
  engine: engineConfigSchema,
  pricing: pricingConfigSchema,
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
