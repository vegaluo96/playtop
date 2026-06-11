/**
 * API-Football v3 客户端（新平台数据层地基，从零重写）：
 * - key 仅从服务器 env `API_FOOTBALL_KEY` 读取（绝不入库/入仓库）
 * - 统一响应信封（所有 v3 端点同构）：errors 非空即业务错误（HTTP 仍 200）
 * - 进程内 TTL 缓存 + 同 URL 最小间隔（保护配额）；12s 超时防挂死
 * - 与产品形态无关：上层（引擎/页面聚合）等设计定稿后再建
 */

export const AF_BASE = "https://v3.football.api-sports.io";

/** v3 统一响应信封 */
export interface AfEnvelope {
  get?: string;
  parameters?: Record<string, string> | unknown[];
  errors?: unknown;
  results?: number;
  paging?: { current?: number; total?: number };
  response?: unknown;
}

export function afKey(): string | null {
  // 后台可在「系统设置」更换密钥(kv 优先,env 兜底);延迟 require 避免构建期循环
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cfgAfKey } = require("../platform/config") as { cfgAfKey: () => string | null };
    return cfgAfKey();
  } catch {
    const k = process.env.API_FOOTBALL_KEY?.trim();
    return k ? k : null;
  }
}

export function afConfigured(): boolean {
  return afKey() !== null;
}

/** AF 把鉴权/配额/参数错误放 errors（非空对象或非空数组）里，HTTP 仍 200 */
export function afHasErrors(env: AfEnvelope): boolean {
  const e = env.errors;
  if (!e || typeof e !== "object") return false;
  return Array.isArray(e) ? e.length > 0 : Object.keys(e).length > 0;
}

export function afErrorText(env: AfEnvelope): string {
  return JSON.stringify(env.errors).slice(0, 300);
}

/** 进程内缓存：同一 path 在 TTL 内直接复用（默认 10 分钟）；force 跳过 */
const cache = new Map<string, { at: number; env: AfEnvelope }>();
const DEFAULT_TTL_MS = 10 * 60_000;
/** 同一 path 两次真实出网的最小间隔（即便 force，也防手抖连点烧配额） */
const MIN_INTERVAL_MS = 2_000;
const lastFetchAt = new Map<string, number>();

export interface AfGetOptions {
  /** 跳过 TTL 缓存（仍受最小间隔约束） */
  force?: boolean;
  /** 覆盖缓存 TTL（毫秒） */
  ttlMs?: number;
}

/**
 * 调用任意 v3 端点路径（含 query），返回完整信封；不对 errors 抛错（交调用方判断）。
 * key 缺失抛错（整源缺席口径）；网络/HTTP 层错误抛错。
 */
export async function afGet(path: string, opts: AfGetOptions = {}): Promise<AfEnvelope> {
  const key = afKey();
  if (!key) throw new Error("API_FOOTBALL_KEY 未配置");
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(path);
  if (!opts.force && hit && Date.now() - hit.at < ttl) return hit.env;
  const last = lastFetchAt.get(path) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_MS && hit) return hit.env;
  lastFetchAt.set(path, Date.now());

  const res = await fetch(`${AF_BASE}${path}`, {
    headers: { "x-apisports-key": key, accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}：${path}`);
  const env = (await res.json()) as AfEnvelope;
  cache.set(path, { at: Date.now(), env });
  return env;
}

/** 同 afGet，但 errors 非空直接抛（适合"必须成功"的链路） */
export async function afGetOk(path: string, opts?: AfGetOptions): Promise<AfEnvelope> {
  const env = await afGet(path, opts);
  if (afHasErrors(env)) throw new Error(`API-Football 错误：${afErrorText(env)}`);
  return env;
}

/**
 * 分页聚合：response 为数组的列表端点，拉满 maxPages 页合并返回。
 * 注意配额消耗 = 页数；调用方自行限页。
 */
export async function afGetAllPages(path: string, maxPages = 5, opts?: AfGetOptions): Promise<AfEnvelope> {
  const sep = path.includes("?") ? "&" : "?";
  const first = await afGet(path, opts);
  const total = Math.min(first.paging?.total ?? 1, maxPages);
  if (total <= 1 || !Array.isArray(first.response)) return first;
  const merged = [...first.response];
  for (let pg = 2; pg <= total; pg++) {
    try {
      const more = await afGet(`${path}${sep}page=${pg}`, opts);
      if (Array.isArray(more.response)) merged.push(...more.response);
    } catch {
      break; // 后续页失败不影响已取到的
    }
  }
  return { ...first, response: merged, results: merged.length, paging: { current: 1, total: 1 } };
}

/** 仅测试用：清空缓存与间隔记录 */
export function _resetAfClientForTest(): void {
  cache.clear();
  lastFetchAt.clear();
}
