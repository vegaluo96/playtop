/**
 * 大模型网关客户端(API易 apiyi.com,OpenAI 兼容 /chat/completions)。
 * 密钥由后台「系统设置」管理(kv 优先,env 兜底);余额查询用独立密钥。
 */
import { cfgLlmBalanceKey, cfgLlmBase, cfgLlmKey, cfgLlmModel } from "../platform/config";
import { kvSet } from "../af/store";

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

/** 余额查询(OneAPI/NewAPI 风格:subscription 上限 - usage 已用);结果落 kv llm_balance */
export async function fetchLlmBalance(): Promise<number | null> {
  const key = cfgLlmBalanceKey() || cfgLlmKey();
  if (!key) return null;
  const base = cfgLlmBase();
  const auth = { authorization: `Bearer ${key}` };
  try {
    const sub = (await fetch(`${base}/dashboard/billing/subscription`, { headers: auth, signal: AbortSignal.timeout(15_000) }).then((r) =>
      r.json(),
    )) as { hard_limit_usd?: number; system_hard_limit_usd?: number };
    const usage = (await fetch(`${base}/dashboard/billing/usage`, { headers: auth, signal: AbortSignal.timeout(15_000) }).then((r) =>
      r.json(),
    )) as { total_usage?: number };
    const limit = sub.hard_limit_usd ?? sub.system_hard_limit_usd ?? 0;
    const used = (usage.total_usage ?? 0) / 100;
    const balance = Math.round((limit - used) * 100) / 100;
    kvSet("llm_balance", JSON.stringify({ usd: balance, at: Date.now() }));
    return balance;
  } catch {
    return null;
  }
}
