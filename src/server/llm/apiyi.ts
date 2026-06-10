import { getConfig } from "../lib/config";

/**
 * apiyi（API易）客户端：OpenAI 兼容 /chat/completions，原生 fetch 直连。
 * LLM=mock 时返回调用方提供的兜底内容（端到端模拟/无 key 环境）。
 */

export interface ChatOptions {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  /** LLM=mock 或调用失败时的兜底内容（由调用方给出合规内容） */
  mock?: string;
}

export class LlmUnavailableError extends Error {}

export async function chatCompletion(opts: ChatOptions): Promise<string> {
  if (process.env.LLM === "mock") {
    if (opts.mock !== undefined) return opts.mock;
    throw new LlmUnavailableError("LLM mock 模式但未提供 mock 内容");
  }
  const cfg = getConfig("apiyi");
  if (!cfg.apiKey) throw new LlmUnavailableError("apiyi 尚未配置 API Key（管理后台 → 设置）");
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: cfg.temperature,
      max_tokens: opts.maxTokens ?? 1800,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LlmUnavailableError(`apiyi 调用失败 HTTP ${res.status}：${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmUnavailableError("apiyi 返回空内容");
  return content;
}

export async function testApiyiConnection(): Promise<{ ok: boolean; latencyMs: number; reply: string }> {
  const start = Date.now();
  const reply = await chatCompletion({
    system: "你是连通性测试助手，只回复两个字：正常",
    user: "连通性测试",
    maxTokens: 16,
    mock: "正常",
  });
  return { ok: true, latencyMs: Date.now() - start, reply: reply.slice(0, 50) };
}
