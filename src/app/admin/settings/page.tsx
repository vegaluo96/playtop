"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/admin/api";

interface Settings {
  apiyi: {
    baseUrl: string;
    apiKey: string;
    model: string;
    models: { retrieval: string; writing: string; fast: string };
    temperature: number;
  };
  datasources: {
    enabledLeagues: string[];
    csvBase: string;
    aiRetrievalEnabled: boolean;
    aiOddsForCsvLeagues: boolean;
    sourceAutoDisableAfter: number;
    apiFootballKey: string;
  } & Record<string, unknown>;
  engine: Record<string, unknown> & { ensembleWeights: { market: number; dc: number; elo: number } };
  pricing: { defaultPricePoints: number };
  automation: {
    autoCollect: boolean;
    autoAnalyze: boolean;
    autoPublish: boolean;
    readyWithoutOddsHours: number;
    pipelineWindowHours: number;
    autoConfirmAiResults: boolean;
    aiResultConfirmPolicy: "double_check" | "delay";
    aiResultConfirmDelayHours: number;
  };
}

interface SourceRow {
  key: string;
  label: string;
  note: string;
  weightNote: string;
  configKey: string | null;
  enabled: boolean;
  autoDisabled: boolean;
  okCount: number;
  failCount: number;
  consecutiveFails: number;
  lastOkAt: number | null;
  lastError: string | null;
}

const AUTOMATION_FLAGS: { key: "autoCollect" | "autoAnalyze" | "autoPublish" | "autoConfirmAiResults"; label: string }[] = [
  { key: "autoCollect", label: "自动采集（每 30 分钟，临近 48h 场次）" },
  { key: "autoAnalyze", label: "自动建模（数据就绪即运行引擎）" },
  { key: "autoPublish", label: "自动发布（按默认积分价上线首版）" },
  { key: "autoConfirmAiResults", label: "AI 赛果自动确认结算（安全栏见下）" },
];

const LEAGUE_OPTIONS: { code: string; name: string }[] = [
  { code: "E0", name: "英超" },
  { code: "E1", name: "英冠" },
  { code: "SP1", name: "西甲" },
  { code: "SP2", name: "西乙" },
  { code: "I1", name: "意甲" },
  { code: "I2", name: "意乙" },
  { code: "D1", name: "德甲" },
  { code: "D2", name: "德乙" },
  { code: "F1", name: "法甲" },
  { code: "F2", name: "法乙" },
  { code: "N1", name: "荷甲" },
  { code: "B1", name: "比甲" },
  { code: "P1", name: "葡超" },
  { code: "T1", name: "土超" },
  { code: "G1", name: "希超" },
  { code: "SC0", name: "苏超" },
];

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [msg, setMsg] = useState("");

  const loadSources = () =>
    api<{ sources: SourceRow[] }>("/api/admin/settings/sources")
      .then((d) => setSources(d.sources))
      .catch(() => {});
  useEffect(() => {
    void api<Settings>("/api/admin/settings").then(setS).catch((e) => setMsg(e.message));
    void loadSources();
  }, []);

  async function runHealthCheck() {
    setMsg("数据源体检中（真实拉取全部源，约 10-30 秒）…");
    try {
      const r = await api<{ 体检: { 源: string; 状态: string; 结果: string }[] }>("/api/admin/settings/test-sources", {
        method: "POST",
      });
      setMsg(r.体检.map((x) => `${x.状态} ${x.源} —— ${x.结果}`).join("\n"));
      void loadSources();
    } catch (e) {
      setMsg(`✗ 体检失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async function save(key: string, value: unknown) {
    setMsg("保存中…");
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({ key, value }) });
      setMsg(`✓ ${key} 已保存`);
    } catch (e) {
      setMsg(`保存失败：${e instanceof Error ? e.message : e}`);
    }
  }

  async function test(path: string, label: string) {
    setMsg(`${label} 测试中…`);
    try {
      const r = await api(path, { method: "POST" });
      setMsg(`✓ ${label}：${JSON.stringify(r)}`);
    } catch (e) {
      setMsg(`✗ ${label}：${e instanceof Error ? e.message : e}`);
    }
  }

  async function importHistory(body: Record<string, unknown>, label: string) {
    setMsg(`${label} 执行中（可能需要几分钟）…`);
    try {
      const r = await api("/api/admin/import-history", { method: "POST", body: JSON.stringify(body) });
      setMsg(`✓ ${label}：${JSON.stringify(r)}`);
    } catch (e) {
      setMsg(`✗ ${label}：${e instanceof Error ? e.message : e}`);
    }
  }

  if (!s) return <p className="text-muted">{msg || "加载中…"}</p>;

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-lg tracking-wider">系统设置</h1>
      {msg && <p className="mt-2 break-all whitespace-pre-line rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      {/* apiyi */}
      <section className="card mt-5 p-4">
        <h2 className="font-display text-sm tracking-wider text-gold-bright">apiyi（AI 接口，OpenAI 兼容）</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">Base URL</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.baseUrl} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, baseUrl: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">API Key（留尾号不变则不修改）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.apiKey} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, apiKey: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">缺省模型（下方三类未填时使用）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.model} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, model: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">temperature</span>
            <input type="number" step="0.1" min="0" max="2" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.temperature} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, temperature: Number(e.target.value) } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">检索模型（情报/盘口/赛果，建议带联网搜索，如 gemini-2.5-pro）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" placeholder="留空用缺省模型" value={s.apiyi.models.retrieval} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, models: { ...s.apiyi.models, retrieval: e.target.value } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">写作模型（研报正文，建议旗舰写作模型，如 claude-sonnet-4-6）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" placeholder="留空用缺省模型" value={s.apiyi.models.writing} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, models: { ...s.apiyi.models, writing: e.target.value } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">快速模型（校验类轻任务，如 gemini-2.5-flash）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" placeholder="留空用缺省模型" value={s.apiyi.models.fast} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, models: { ...s.apiyi.models, fast: e.target.value } } })} />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={() => save("apiyi", s.apiyi)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存</button>
          <button onClick={() => test("/api/admin/settings/test-apiyi", "apiyi 连通性")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">测试连接</button>
        </div>
      </section>

      {/* 数据源 */}
      <section className="card mt-4 p-4">
        <h2 className="font-display text-sm tracking-wider text-gold-bright">数据源</h2>

        {/* 付费主源：API-Football */}
        <div className="mt-3 rounded border border-gold/30 bg-gold/5 p-3">
          <div className="font-display text-[12px] tracking-wider text-gold-bright">API-Football（付费主源）</div>
          <p className="mt-1 text-[10.5px] leading-4 text-faint">
            大书商盘口（bet365 / Pinnacle / 威廉希尔等，含亚盘/波胆）+ 官方首发 + 伤停 + 权威赛果。
            填入 key 保存后下一轮采集自动生效；留空则回落到服务器 env 的 API_FOOTBALL_KEY。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              className="tabular min-w-[280px] flex-1 rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]"
              placeholder="API-Football key（api-sports.io 控制台获取）"
              value={s.datasources.apiFootballKey}
              onChange={(e) => setS({ ...s, datasources: { ...s.datasources, apiFootballKey: e.target.value.trim() } })}
            />
            <button onClick={() => save("datasources", s.datasources)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">
              保存
            </button>
            <button onClick={runHealthCheck} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">
              体检验证
            </button>
          </div>
        </div>

        <div className="mt-3">
          <span className="text-[10px] tracking-wider text-faint">启用联赛（football-data.co.uk 代码）</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {LEAGUE_OPTIONS.map(({ code, name }) => {
              const on = s.datasources.enabledLeagues.includes(code);
              return (
                <button
                  key={code}
                  onClick={() =>
                    setS({
                      ...s,
                      datasources: {
                        ...s.datasources,
                        enabledLeagues: on
                          ? s.datasources.enabledLeagues.filter((x) => x !== code)
                          : [...s.datasources.enabledLeagues, code],
                      },
                    })
                  }
                  className={`rounded border px-2 py-1 text-[11px] ${on ? "border-gold/60 text-gold-bright" : "border-hairline text-faint"}`}
                >
                  {name} {code}
                </button>
              );
            })}
          </div>
          <label className="mt-3 flex items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={s.datasources.aiRetrievalEnabled}
              onChange={(e) => setS({ ...s, datasources: { ...s.datasources, aiRetrievalEnabled: e.target.checked } })}
            />
            启用 AI 检索（伤停/教练/阵容/舆情等软维度，走 apiyi）
          </label>
          <label className="mt-2 flex items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={s.datasources.aiOddsForCsvLeagues}
              onChange={(e) => setS({ ...s, datasources: { ...s.datasources, aiOddsForCsvLeagues: e.target.checked } })}
            />
            CSV 联赛也走 AI 多家报价（联赛已有官方盘口，开启会增加 token 成本）
          </label>
        </div>

        {/* 数据源因子表：注释（喂什么维度）+ 权重 + 健康状态 + 开关 */}
        <h3 className="font-display mt-5 text-[12px] tracking-wider text-muted">
          数据源因子表（连败 {s.datasources.sourceAutoDisableAfter} 次自动停用，体检成功自动复活）
        </h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[760px] text-[11.5px]">
            <thead>
              <tr className="text-left text-[10px] tracking-wider text-faint">
                <th className="pb-1 font-normal">启用</th>
                <th className="pb-1 font-normal">数据源</th>
                <th className="pb-1 font-normal">注释（喂什么维度）</th>
                <th className="pb-1 font-normal">模型权重</th>
                <th className="pb-1 font-normal">健康</th>
                <th className="pb-1 text-right font-normal">成/败</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((src) => (
                <tr key={src.key} className={`border-t border-hairline ${src.autoDisabled ? "opacity-60" : ""}`}>
                  <td className="py-1.5">
                    {src.configKey ? (
                      <input
                        type="checkbox"
                        checked={!!s.datasources[src.configKey]}
                        onChange={(e) => {
                          setS({ ...s, datasources: { ...s.datasources, [src.configKey!]: e.target.checked } });
                          setSources(sources.map((x) => (x.key === src.key ? { ...x, enabled: e.target.checked } : x)));
                        }}
                      />
                    ) : (
                      <span className="text-faint">常开</span>
                    )}
                  </td>
                  <td className="py-1.5 whitespace-nowrap">{src.label}</td>
                  <td className="py-1.5 text-muted">{src.note}</td>
                  <td className="py-1.5 text-muted">{src.weightNote}</td>
                  <td className="py-1.5 whitespace-nowrap">
                    {src.autoDisabled ? (
                      <span className="text-down">自动停用（连败 {src.consecutiveFails}）</span>
                    ) : src.consecutiveFails > 0 ? (
                      <span className="text-down">连败 {src.consecutiveFails}</span>
                    ) : src.okCount > 0 ? (
                      <span className="text-up">正常</span>
                    ) : (
                      <span className="text-faint">未体检</span>
                    )}
                  </td>
                  <td className="tabular py-1.5 text-right text-muted">
                    {src.okCount}/{src.failCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => save("datasources", s.datasources)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存</button>
          <button onClick={() => test("/api/admin/settings/test-datasource", "数据源连通性")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">测试连接</button>
          <button onClick={runHealthCheck} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] font-semibold text-gold-bright">数据源体检（全部源真实拉取）</button>
          <button onClick={() => importHistory({ type: "club", seasons: 3 }, "导入俱乐部历史（3 季）")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">导入俱乐部历史</button>
          <button onClick={() => importHistory({ type: "international", sinceYear: 2018 }, "导入国际赛历史")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">导入国际赛历史（世界杯用）</button>
          <button onClick={() => importHistory({ type: "backfill_elo" }, "Elo 全量回放")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">Elo 全量回放</button>
        </div>
      </section>

      {/* 自动化 */}
      <section className="card mt-4 p-4">
        <h2 className="font-display text-sm tracking-wider text-gold-bright">全自动流水线</h2>
        <p className="mt-1 text-[11px] leading-5 text-faint">
          全开 = 建赛→采集→建模→发布→改版→赛果→结算零人工；任意一项关闭即回退到该环节的人工流程。
        </p>
        <div className="mt-3 space-y-2">
          {AUTOMATION_FLAGS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={s.automation[f.key]}
                onChange={(e) => setS({ ...s, automation: { ...s.automation, [f.key]: e.target.checked } })}
              />
              {f.label}
            </label>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">无盘口兜底（距开球 N 小时强制进就绪，0=关闭）</span>
            <input type="number" min="0" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.automation.readyWithoutOddsHours} onChange={(e) => setS({ ...s, automation: { ...s.automation, readyWithoutOddsHours: Number(e.target.value) } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">流水线窗口（开球前 N 小时开始采集建模发布）</span>
            <input type="number" min="1" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.automation.pipelineWindowHours} onChange={(e) => setS({ ...s, automation: { ...s.automation, pipelineWindowHours: Number(e.target.value) } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">AI 赛果确认策略</span>
            <select className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.automation.aiResultConfirmPolicy} onChange={(e) => setS({ ...s, automation: { ...s.automation, aiResultConfirmPolicy: e.target.value as "double_check" | "delay" } })}>
              <option value="double_check">两次检索同比分才结算（推荐）</option>
              <option value="delay">录入后等 N 小时无人纠正即结算</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">delay 策略等待小时数</span>
            <input type="number" min="1" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.automation.aiResultConfirmDelayHours} onChange={(e) => setS({ ...s, automation: { ...s.automation, aiResultConfirmDelayHours: Number(e.target.value) } })} />
          </label>
        </div>
        <div className="mt-3">
          <button onClick={() => save("automation", s.automation)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存自动化设置</button>
        </div>
      </section>

      {/* 引擎与定价 */}
      <section className="card mt-4 p-4">
        <h2 className="font-display text-sm tracking-wider text-gold-bright">引擎参数与定价</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">集成权重·市场</span>
            <input type="number" step="0.05" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.engine.ensembleWeights.market} onChange={(e) => setS({ ...s, engine: { ...s.engine, ensembleWeights: { ...s.engine.ensembleWeights, market: Number(e.target.value) } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">集成权重·DC</span>
            <input type="number" step="0.05" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.engine.ensembleWeights.dc} onChange={(e) => setS({ ...s, engine: { ...s.engine, ensembleWeights: { ...s.engine.ensembleWeights, dc: Number(e.target.value) } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">集成权重·Elo</span>
            <input type="number" step="0.05" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.engine.ensembleWeights.elo} onChange={(e) => setS({ ...s, engine: { ...s.engine, ensembleWeights: { ...s.engine.ensembleWeights, elo: Number(e.target.value) } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-wider text-faint">默认解锁价（积分）</span>
            <input type="number" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.pricing.defaultPricePoints} onChange={(e) => setS({ ...s, pricing: { defaultPricePoints: Number(e.target.value) } })} />
          </label>
        </div>
        <label className="mt-3 block">
          <span className="text-[10px] tracking-wider text-faint">
            书商因子权重（JSON：书商名 → 权重。未列出默认 1，模拟盘默认 0.3；离群报价引擎自动再降权 80%。改完失焦生效，再点保存）
          </span>
          <textarea
            rows={3}
            className="tabular mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[11px]"
            defaultValue={JSON.stringify(s.engine.bookWeights ?? {})}
            onBlur={(e) => {
              try {
                const v = JSON.parse(e.target.value) as Record<string, number>;
                setS({ ...s, engine: { ...s.engine, bookWeights: v } });
                setMsg("书商权重已应用到表单（记得点「保存引擎参数」）");
              } catch {
                setMsg("✗ 书商权重 JSON 不合法，未应用");
              }
            }}
          />
        </label>
        <div className="mt-3 flex gap-2">
          <button onClick={() => save("engine", s.engine)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存引擎参数</button>
          <button onClick={() => save("pricing", s.pricing)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存定价</button>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-faint">
          其余引擎参数（时间衰减 ξ、ρ、Elo K、Kelly 比例、EV 阈值、射门混合 θ 等）均有学术缺省值，需要微调时通过 API PUT /api/admin/settings 提交 engine 对象。
        </p>
      </section>
    </div>
  );
}
