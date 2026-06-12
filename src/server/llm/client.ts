/**
 * 大模型网关客户端(API易 apiyi.com,OpenAI 兼容 /chat/completions)。
 * 密钥由后台「系统设置」管理(kv 优先,env 兜底);余额查询用独立密钥。
 */
import { cfgLlmBalanceKey, cfgLlmBase, cfgLlmKey, cfgLlmModel } from "../platform/config";
import { kvGet, kvSet } from "../af/store";

export interface ChatResult {
  text: string;
  tokens: number;
}

export async function chatComplete(system: string, user: string, maxTokens = 2200): Promise<ChatResult> {
  const key = cfgLlmKey();
  if (!key) throw new Error("LLM_API_KEY 未配置");
  const res = await fetch(`${cfgLlmBase()}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: cfgLlmModel(),
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
  const text = j.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("LLM 空响应");
  return { text, tokens: j.usage?.total_tokens ?? Math.ceil((system.length + user.length + text.length) / 3) };
}

/**
 * 余额查询(OneAPI/NewAPI 风格:subscription 上限 - usage 已用);结果落 kv llm_balance。
 * usage 接口必须带 start_date/end_date——缺参时多数网关返回 0,余额会恒等于额度上限(线上已踩坑)。
 */
export function llmUsageWindow(now = Date.now()): { start: string; end: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: day(now - 90 * 86_400_000), end: day(now + 86_400_000) };
}

export interface LlmBalanceSnapshot {
  usd: number | null;
  limit?: number;
  used?: number;
  at: number;
  error?: string;
}

function dig(obj: unknown, ...path: string[]): unknown {
  let cur = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function parseBillingSubscription(input: unknown): number | null {
  const limit = firstFinite(
    dig(input, "hard_limit_usd"),
    dig(input, "system_hard_limit_usd"),
    dig(input, "data", "hard_limit_usd"),
    dig(input, "data", "system_hard_limit_usd"),
    dig(input, "subscription", "hard_limit_usd"),
    dig(input, "subscription", "system_hard_limit_usd"),
  );
  return limit != null && limit > 0 ? limit : null;
}

export function parseBillingUsage(input: unknown): number | null {
  const cents = firstFinite(dig(input, "total_usage"), dig(input, "data", "total_usage"), dig(input, "usage", "total_usage"));
  if (cents != null) return cents / 100;
  return firstFinite(
    dig(input, "total_usage_usd"),
    dig(input, "used_usd"),
    dig(input, "used"),
    dig(input, "data", "total_usage_usd"),
    dig(input, "data", "used_usd"),
    dig(input, "data", "used"),
  );
}

export function readLlmBalance(): LlmBalanceSnapshot | null {
  const raw = kvGet("llm_balance");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LlmBalanceSnapshot>;
    const usd = parsed.usd == null ? null : Number(parsed.usd);
    const limit = parsed.limit == null ? undefined : Number(parsed.limit);
    const used = parsed.used == null ? undefined : Number(parsed.used);
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    if (error) return { usd: null, limit, used, at: Number(parsed.at) || Date.now(), error };
    if (!Number.isFinite(usd)) return null;
    if ((limit == null || !Number.isFinite(limit) || limit <= 0) && usd === 0 && (used == null || used === 0)) return null;
    return { usd, limit, used, at: Number(parsed.at) || Date.now() };
  } catch {
    return null;
  }
}

async function fetchJson(url: string, key: string): Promise<unknown> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchLlmBalance(): Promise<number | null> {
  const keys = [...new Set([cfgLlmBalanceKey(), cfgLlmKey()].filter(Boolean) as string[])];
  if (keys.length === 0) return null;
  const base = cfgLlmBase();
  let lastError = "";
  try {
    for (const key of keys) {
      try {
        const sub = await fetchJson(`${base}/dashboard/billing/subscription`, key);
        const limit = parseBillingSubscription(sub);
        if (limit == null) throw new Error("余额额度字段缺失");
        const { start, end } = llmUsageWindow();
        const usage = await fetchJson(`${base}/dashboard/billing/usage?start_date=${start}&end_date=${end}`, key);
        const usedRaw = parseBillingUsage(usage);
        if (usedRaw == null) throw new Error("用量字段缺失");
        const used = Math.round(usedRaw * 100) / 100;
        const balance = Math.max(0, Math.round((limit - used) * 100) / 100);
        kvSet("llm_balance", JSON.stringify({ usd: balance, limit, used, at: Date.now() }));
        return balance;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    kvSet("llm_balance", JSON.stringify({ usd: null, error: lastError || "余额查询失败", at: Date.now() }));
    return null;
  } catch {
    return null;
  }
}
