"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/admin/api";

interface Settings {
  apiyi: { baseUrl: string; apiKey: string; model: string; temperature: number };
  datasources: { enabledLeagues: string[]; csvBase: string; aiRetrievalEnabled: boolean; sportteryEnabled: boolean };
  engine: Record<string, unknown> & { ensembleWeights: { market: number; dc: number; elo: number } };
  pricing: { defaultPricePoints: number };
}

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
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void api<Settings>("/api/admin/settings").then(setS).catch((e) => setMsg(e.message));
  }, []);

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
      <h1 className="font-display text-lg tracking-widest">系统设置</h1>
      {msg && <p className="mt-2 break-all rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      {/* apiyi */}
      <section className="card mt-5 p-4">
        <h2 className="font-display text-sm tracking-widest text-gold-bright">apiyi（AI 接口，OpenAI 兼容）</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">Base URL</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.baseUrl} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, baseUrl: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">API Key（留尾号不变则不修改）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.apiKey} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, apiKey: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">模型（建议选带联网检索能力的）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.model} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, model: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">temperature</span>
            <input type="number" step="0.1" min="0" max="2" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.apiyi.temperature} onChange={(e) => setS({ ...s, apiyi: { ...s.apiyi, temperature: Number(e.target.value) } })} />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={() => save("apiyi", s.apiyi)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存</button>
          <button onClick={() => test("/api/admin/settings/test-apiyi", "apiyi 连通性")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">测试连接</button>
        </div>
      </section>

      {/* 数据源 */}
      <section className="card mt-4 p-4">
        <h2 className="font-display text-sm tracking-widest text-gold-bright">数据源（全部免 API Key）</h2>
        <div className="mt-3">
          <span className="text-[10px] tracking-widest text-faint">启用联赛（football-data.co.uk 代码）</span>
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
              checked={s.datasources.sportteryEnabled}
              onChange={(e) => setS({ ...s, datasources: { ...s.datasources, sportteryEnabled: e.target.checked } })}
            />
            启用竞彩官方盘口（世界杯/手动赛事自动拉取，零 key；境外 IP 可能不通，先点下方测试）
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => save("datasources", s.datasources)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">保存</button>
          <button onClick={() => test("/api/admin/settings/test-datasource", "数据源连通性")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">测试连接</button>
          <button onClick={() => test("/api/admin/settings/test-sporttery", "竞彩接口")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">测试竞彩接口</button>
          <button onClick={() => importHistory({ type: "club", seasons: 3 }, "导入俱乐部历史（3 季）")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">导入俱乐部历史</button>
          <button onClick={() => importHistory({ type: "international", sinceYear: 2018 }, "导入国际赛历史")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">导入国际赛历史（世界杯用）</button>
          <button onClick={() => importHistory({ type: "backfill_elo" }, "Elo 全量回放")} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted">Elo 全量回放</button>
        </div>
      </section>

      {/* 引擎与定价 */}
      <section className="card mt-4 p-4">
        <h2 className="font-display text-sm tracking-widest text-gold-bright">引擎参数与定价</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">集成权重·市场</span>
            <input type="number" step="0.05" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.engine.ensembleWeights.market} onChange={(e) => setS({ ...s, engine: { ...s.engine, ensembleWeights: { ...s.engine.ensembleWeights, market: Number(e.target.value) } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">集成权重·DC</span>
            <input type="number" step="0.05" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.engine.ensembleWeights.dc} onChange={(e) => setS({ ...s, engine: { ...s.engine, ensembleWeights: { ...s.engine.ensembleWeights, dc: Number(e.target.value) } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">集成权重·Elo</span>
            <input type="number" step="0.05" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.engine.ensembleWeights.elo} onChange={(e) => setS({ ...s, engine: { ...s.engine, ensembleWeights: { ...s.engine.ensembleWeights, elo: Number(e.target.value) } } })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">默认解锁价（积分）</span>
            <input type="number" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={s.pricing.defaultPricePoints} onChange={(e) => setS({ ...s, pricing: { defaultPricePoints: Number(e.target.value) } })} />
          </label>
        </div>
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
