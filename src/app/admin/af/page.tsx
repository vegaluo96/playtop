"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/components/admin/api";

interface ParamSpec {
  name: string;
  required?: boolean;
  hint?: string;
}
interface Endpoint {
  key: string;
  label: string;
  path: string;
  params: ParamSpec[];
  doc: string;
}
interface Group {
  group: string;
  endpoints: Endpoint[];
}
interface QueryResult {
  key: string;
  path: string;
  ok: boolean;
  results: number;
  paging: { current: number; total: number };
  errors: unknown;
  response: unknown;
}

export default function AfDataCenterPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [catalog, setCatalog] = useState<Group[]>([]);
  const [activeKey, setActiveKey] = useState<string>("status");
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    api<{ configured: boolean; catalog: Group[] }>("/api/admin/af")
      .then((d) => {
        setConfigured(d.configured);
        setCatalog(d.catalog);
      })
      .catch((e) => setMsg(`目录加载失败：${e.message}`));
  }, []);

  const active = useMemo(() => {
    for (const g of catalog) for (const e of g.endpoints) if (e.key === activeKey) return e;
    return null;
  }, [catalog, activeKey]);

  const total = useMemo(() => catalog.reduce((s, g) => s + g.endpoints.length, 0), [catalog]);

  function selectEndpoint(key: string) {
    setActiveKey(key);
    setParams({});
    setResult(null);
    setMsg("");
  }

  async function run() {
    if (!active) return;
    setLoading(true);
    setMsg("");
    setResult(null);
    try {
      const r = await api<QueryResult>("/api/admin/af", {
        method: "POST",
        body: JSON.stringify({ key: active.key, params }),
      });
      setResult(r);
      if (!r.ok) setMsg("AF 返回 errors（见下方），通常是参数缺失/配额/套餐限制。");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "调用失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-baseline justify-between">
        <h1 className="font-display text-lg tracking-wider text-gold-bright">AF 数据中心</h1>
        <span className="text-[11px] text-faint">API-Football v3 · {total} 个端点全覆盖</span>
      </div>
      <p className="mt-1 text-[11.5px] leading-5 text-muted">
        基于 API-Football v3 的套壳数据控制台——官方文档每一个数据端点都可在此直接调用、查看原始响应。
        引擎与采集仍走各自的专用解析链路；此处用于即时查数据、调参、排障与覆盖核验。
      </p>
      <div className="mt-2 text-[11px]">
        连通状态：
        {configured === null ? (
          <span className="text-faint"> 检测中…</span>
        ) : configured ? (
          <span className="text-emerald-500"> 已配置 key</span>
        ) : (
          <span className="text-amber-500"> 未配置 key（在 系统设置→数据源 填入，或服务器 env API_FOOTBALL_KEY）</span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
        {/* 端点目录 */}
        <nav className="max-h-[70vh] overflow-y-auto rounded border border-hairline">
          {catalog.map((g) => (
            <div key={g.group} className="border-b border-hairline last:border-0">
              <div className="bg-overlay/40 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-faint">{g.group}</div>
              {g.endpoints.map((e) => (
                <button
                  key={e.key}
                  onClick={() => selectEndpoint(e.key)}
                  className={`block w-full px-3 py-1.5 text-left text-[12px] ${
                    e.key === activeKey ? "bg-gold/10 text-gold-bright" : "text-muted hover:bg-overlay/60 hover:text-ink"
                  }`}
                >
                  {e.label}
                  <span className="ml-1 text-[9px] text-faint">{e.path}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* 调用面板 */}
        <section className="min-w-0">
          {active ? (
            <div className="rounded border border-hairline p-4">
              <div className="font-display text-sm text-ink">{active.label}</div>
              <div className="mt-0.5 text-[11px] text-faint">
                <code>GET {active.path}</code>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-5 text-muted">{active.doc}</p>

              {active.params.length > 0 ? (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {active.params.map((p) => (
                    <label key={p.name} className="block">
                      <span className="text-[10px] tracking-wider text-faint">
                        {p.name}
                        {p.required && <span className="ml-0.5 text-amber-500">*</span>}
                        {p.hint && <span className="ml-1 text-faint">· {p.hint}</span>}
                      </span>
                      <input
                        value={params[p.name] ?? ""}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                        className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]"
                        placeholder={p.required ? "必填" : "可选"}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="mt-3 text-[11px] text-faint">无参数，直接调用。</div>
              )}

              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={run}
                  disabled={loading || configured === false}
                  className="rounded border border-gold/50 px-3 py-1.5 text-[12px] font-semibold text-gold-bright disabled:opacity-40"
                >
                  {loading ? "调用中…" : "调用"}
                </button>
                {msg && <span className="text-[11px] text-amber-500">{msg}</span>}
              </div>

              {result && (
                <div className="mt-4">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span className={`rounded px-1.5 py-0.5 ${result.ok ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}`}>
                      {result.ok ? "OK" : "ERRORS"}
                    </span>
                    <span>结果数 {result.results}</span>
                    <span>分页 {result.paging.current}/{result.paging.total}</span>
                    <code className="text-faint">{result.path}</code>
                  </div>
                  {!result.ok && (
                    <pre className="tabular mt-2 max-h-40 overflow-auto rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[10.5px] leading-4 text-amber-600">
                      {JSON.stringify(result.errors, null, 2)}
                    </pre>
                  )}
                  <pre className="tabular mt-2 max-h-[50vh] overflow-auto rounded border border-hairline bg-overlay/30 p-2 text-[10.5px] leading-4 text-muted">
                    {JSON.stringify(result.response, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded border border-hairline p-6 text-[12px] text-faint">从左侧选择一个端点。</div>
          )}
        </section>
      </div>
    </div>
  );
}
