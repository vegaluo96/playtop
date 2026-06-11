import { eq } from "drizzle-orm";
import { db } from "../db";
import { dataProviderHealth, providers, rawApiPayloads } from "../db/schema";
import { sha256Hex } from "../lib/hash";
import { now } from "../lib/time";

/**
 * 数据源注册 + 原始响应留档（合规铁律：所有第三方原始响应原样保存，截断保护）。
 * providers 从 SOURCE_REGISTRY 引导填充（幂等）；raw_api_payloads 由 politeFetchText 统一落档；
 * data_provider_health 记录体检延迟时间序列。
 */

const PROVIDER_SEED: { name: string; type: "football_data" | "odds" | "weather" | "news" | "result" | "dataset"; priority: number }[] = [
  { name: "api_football", type: "odds", priority: 5 },
  { name: "football_data_couk", type: "football_data", priority: 10 },
  { name: "espn", type: "result", priority: 10 },
  { name: "sporttery", type: "odds", priority: 20 },
  { name: "polymarket", type: "odds", priority: 30 },
  { name: "smarkets", type: "odds", priority: 20 },
  { name: "manifold", type: "odds", priority: 90 },
  { name: "eloratings", type: "football_data", priority: 40 },
  { name: "clubelo", type: "football_data", priority: 40 },
  { name: "understat", type: "football_data", priority: 50 },
  { name: "github", type: "dataset", priority: 40 },
  { name: "open_meteo", type: "weather", priority: 30 },
  { name: "llm", type: "news", priority: 60 },
  { name: "thesportsdb", type: "result", priority: 80 },
  { name: "openligadb", type: "result", priority: 80 },
];

export function seedProviders(): void {
  for (const p of PROVIDER_SEED) {
    const existing = db.select().from(providers).where(eq(providers.name, p.name)).get();
    if (!existing) {
      db.insert(providers)
        .values({ ...p, status: "active", createdAt: now(), updatedAt: now() })
        .run();
    }
  }
}

export function providerIdByName(name: string): number | null {
  return db.select({ id: providers.id }).from(providers).where(eq(providers.name, name)).get()?.id ?? null;
}

/** URL 主机名 → provider 名（原始留档归属判定，best-effort） */
const HOST_PROVIDER: [RegExp, string][] = [
  [/api-sports\.io/, "api_football"],
  [/football-data\.co\.uk/, "football_data_couk"],
  [/espn\.com/, "espn"],
  [/sporttery\.cn/, "sporttery"],
  [/polymarket\.com/, "polymarket"],
  [/smarkets\.com/, "smarkets"],
  [/manifold\.markets/, "manifold"],
  [/eloratings\.net/, "eloratings"],
  [/clubelo\.com/, "clubelo"],
  [/understat\.com/, "understat"],
  [/githubusercontent\.com|github\.com/, "github"],
  [/open-meteo\.com/, "open_meteo"],
  [/thesportsdb\.com/, "thesportsdb"],
  [/openligadb\.de/, "openligadb"],
];

export function providerForUrl(url: string): string | null {
  for (const [re, name] of HOST_PROVIDER) if (re.test(url)) return name;
  return null;
}

/** 原始正文留档上限（goalscorers.csv 等大文件截断保存，标记 truncated） */
const MAX_BODY = 512 * 1024;

export function recordRawPayload(input: {
  endpoint: string;
  httpStatus: number | null;
  body: string | null;
  errorMessage?: string | null;
  requestParams?: unknown;
}): void {
  try {
    const truncated = input.body !== null && input.body.length > MAX_BODY;
    db.insert(rawApiPayloads)
      .values({
        providerId: providerIdByName(providerForUrl(input.endpoint) ?? "") ?? null,
        endpoint: input.endpoint.slice(0, 600),
        requestParamsJson: input.requestParams ? JSON.stringify(input.requestParams) : null,
        responseJson:
          input.body === null ? null : truncated ? `${input.body.slice(0, MAX_BODY)}\n…[truncated ${input.body.length} bytes]` : input.body,
        httpStatus: input.httpStatus,
        fetchedAt: now(),
        responseHash: input.body !== null ? sha256Hex(input.body) : null,
        errorMessage: input.errorMessage ?? null,
        createdAt: now(),
      })
      .run();
  } catch (e) {
    // 留档失败绝不阻塞业务抓取
    console.warn("[v2] raw payload 留档失败:", e instanceof Error ? e.message : e);
  }
}

/** 健康时间序列（数据源体检时按 provider 记一条） */
export function recordProviderHealth(input: {
  providerName: string;
  latencyMs: number | null;
  ok: boolean;
  details?: unknown;
}): void {
  const pid = providerIdByName(input.providerName);
  if (!pid) return;
  db.insert(dataProviderHealth)
    .values({
      providerId: pid,
      checkedAt: now(),
      latencyMs: input.latencyMs,
      errorRate: input.ok ? 0 : 1,
      missingRate: null,
      abnormalCount: input.ok ? 0 : 1,
      status: input.ok ? "active" : "error",
      healthScore: input.ok ? 1 : 0,
      detailsJson: input.details ? JSON.stringify(input.details) : null,
      createdAt: now(),
    })
    .run();
}
