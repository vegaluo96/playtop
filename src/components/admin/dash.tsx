"use client";

/** 运营看板:告警条 + KPI + 7日图 + 配额 + 热门/构成/流水/漏斗 */
import { useEffect, useState } from "react";
import { ACard, AGrid, Th } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export function DashView() {
  const [v, setV] = useState<V | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/admin/overview").then((r) => r.json()).then((j) => j.ok && setV(j));
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!v) return <div style={{ color: "var(--fg-3)", fontSize: 12, padding: 40, textAlign: "center" }}>加载中…</div>;

  const kpiColor = (c?: string) => (c === "gold" ? "var(--gold)" : c === "red" ? "var(--red)" : "var(--fg)");
  const maxRev = Math.max(...v.week.map((w: V) => w.rev), 1);
  const maxReg = Math.max(...v.week.map((w: V) => w.reg), 1);
  const afPct = v.af?.limit ? Math.round((v.af.current / v.af.limit) * 100) : null;
  const llmPct = v.llm.budget ? Math.round((v.llm.tokens / v.llm.budget) * 100) : 0;

  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>
        运营看板 <span style={{ fontSize: 10, color: "var(--fg-3)", fontWeight: 400 }}>· 今日 {v.date.slice(5)} · 实时</span>
      </div>
      {v.alerts.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, background: "rgba(233,185,73,.07)", border: "1px solid rgba(233,185,73,.3)", borderRadius: 10, padding: "8px 14px", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)", flexShrink: 0 }}>⚠ 告警</span>
          {v.alerts.map((a: string, i: number) => (
            <span key={i} style={{ fontSize: 11, color: "var(--fg-mid)" }}>{a}</span>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(0,1fr))", gap: 12, marginBottom: 14 }}>
        {v.kpis.map((k: V) => (
          <div key={k.label} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "13px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 6 }}>{k.label}</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: kpiColor(k.c), whiteSpace: "nowrap" }}>{k.v}</div>
            <div style={{ fontSize: 9.5, marginTop: 4, color: k.delta?.startsWith("↑") ? "var(--green)" : k.delta?.startsWith("↓") ? "var(--red)" : "var(--fg-2)", minHeight: 12 }}>{k.delta}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr 1fr", gap: 14 }}>
        <ACard title="近 7 日收入(元)">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 128 }}>
            {v.week.map((b: V) => (
              <div key={b.d} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
                <span className="mono" style={{ fontSize: 8.5, color: "var(--fg-2)" }}>{b.rev > 0 ? b.rev : ""}</span>
                <div style={{ width: "100%", borderRadius: "3px 3px 0 0", background: "linear-gradient(180deg,var(--gold),#8a6a1f)", height: Math.max(2, Math.round((b.rev / maxRev) * 88)) }} />
                <span className="mono" style={{ fontSize: 8.5, color: "var(--fg-3)" }}>{b.d}</span>
              </div>
            ))}
          </div>
        </ACard>
        <ACard title="近 7 日新增注册">
          <div style={{ display: "flex", gap: 7, alignItems: "flex-end", height: 128 }}>
            {v.week.map((b: V) => (
              <div key={b.d} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
                <span className="mono" style={{ fontSize: 8.5, color: "var(--fg-2)" }}>{b.reg > 0 ? b.reg : ""}</span>
                <div style={{ width: "100%", borderRadius: "3px 3px 0 0", background: "linear-gradient(180deg,var(--home),#2c4a7a)", height: Math.max(2, Math.round((b.reg / maxReg) * 88)) }} />
                <span className="mono" style={{ fontSize: 8.5, color: "var(--fg-3)" }}>{b.d}</span>
              </div>
            ))}
          </div>
        </ACard>
        <ACard title="API 配额" right={<span className="mono" style={{ fontSize: 9, color: "var(--fg-3)" }}>{v.af?.plan ?? "—"} · /status</span>}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800 }}>
            {v.af?.current?.toLocaleString() ?? "—"} <span style={{ fontSize: 10, color: "var(--fg-3)", fontWeight: 400 }}>/ {v.af?.limit?.toLocaleString() ?? "—"} req</span>
          </div>
          <div style={{ height: 7, background: "var(--inset)", borderRadius: 4, overflow: "hidden", margin: "8px 0" }}>
            <div style={{ height: "100%", background: afPct != null && afPct > 85 ? "var(--red)" : "var(--green)", width: `${afPct ?? 0}%` }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-2)", lineHeight: 1.7 }}>{afPct != null ? `已用 ${afPct}%` : "等待 worker 上报 /status"}</div>
          <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 9, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, color: "var(--fg-2)" }}>快照归档(今日)</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--green)" }}>{v.snapsToday.toLocaleString()} 条</span>
          </div>
        </ACard>
        <ACard title="大模型配额" right={<span className="mono" style={{ fontSize: 9, color: "var(--fg-3)" }}>AI 报告生成</span>}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800 }}>
            {(v.llm.tokens / 1e6).toFixed(2)}M <span style={{ fontSize: 10, color: "var(--fg-3)", fontWeight: 400 }}>/ {(v.llm.budget / 1e6).toFixed(0)}M tokens</span>
          </div>
          <div style={{ height: 7, background: "var(--inset)", borderRadius: 4, overflow: "hidden", margin: "8px 0" }}>
            <div style={{ height: "100%", background: llmPct > 80 ? "var(--red)" : "var(--home)", width: `${Math.min(100, llmPct)}%` }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-2)", lineHeight: 1.7 }}>
            {v.llm.configured ? `今日生成 ${v.llm.count} 份 · 缓存命中 ${v.llm.count + v.llm.hits > 0 ? Math.round((v.llm.hits / (v.llm.count + v.llm.hits)) * 100) : 0}% · 失败 ${v.llm.fails}` : "未接入 · 模板模式"}
          </div>
          <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 9, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, color: "var(--fg-2)" }}>网关余额</span>
            <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: v.llm.balance != null && v.llm.balance < 100 ? "var(--red)" : "var(--green)" }}>
              {v.llm.balance != null ? `$${v.llm.balance}` : "—"}
            </span>
          </div>
        </ACard>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr 1fr", gap: 14, marginTop: 14 }}>
        <ACard title="今日热门场次 Top 5" pad={false}>
          <AGrid cols="1.4fr 70px 56px 64px" head>
            <Th t="比赛" /><Th t="浏览" right /><Th t="解锁" right /><Th t="解锁率" right />
          </AGrid>
          {v.hot.length === 0 && <div style={{ padding: 14, fontSize: 10.5, color: "var(--fg-3)" }}>今日暂无浏览数据(埋点随访问累积)</div>}
          {v.hot.map((h: V) => (
            <AGrid key={h.m} cols="1.4fr 70px 56px 64px">
              <span style={{ fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.m}</span>
              <span className="mono" style={{ fontSize: 10.5, textAlign: "right", color: "var(--fg-2)" }}>{h.pv.toLocaleString()}</span>
              <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, textAlign: "right", color: "var(--gold)" }}>{h.free ? "—" : h.un}</span>
              <span style={{ fontSize: 10, fontWeight: 700, textAlign: "right", color: h.free ? "var(--green)" : "var(--gold)" }}>{h.rate}</span>
            </AGrid>
          ))}
        </ACard>
        <ACard title="今日收入构成(充值档位)">
          {v.revmix.length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>今日暂无充值</div>}
          {v.revmix.map((r: V) => (
            <div key={r.k} style={{ marginBottom: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{r.k}</span>
                <span className="mono" style={{ fontSize: 10.5, fontWeight: 700 }}>{r.v} <span style={{ color: "var(--fg-3)" }}>{r.w}</span></span>
              </div>
              <div style={{ height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", background: "linear-gradient(90deg,#8a6a1f,var(--gold))", width: r.w }} />
              </div>
            </div>
          ))}
        </ACard>
        <ACard title="积分流水(今日)">
          <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 10.5, color: "var(--fg-2)" }}>发放</span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--green)" }}>+{v.flow.grant.toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 9.5, color: "var(--fg-3)", padding: "4px 0 7px", borderBottom: "1px solid var(--line-soft)" }}>
            {v.flow.grantMix.map((g: V) => `${({ recharge: "充值", gift: "礼包", invite: "邀请", redeem: "兑换", adjust: "调整" } as V)[g.kind] ?? g.kind} ${g.v.toLocaleString()}`).join(" · ") || "—"}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 10.5, color: "var(--fg-2)" }}>消耗(解锁预测)</span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--red)" }}>-{v.flow.consume.toLocaleString()}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}>
            <span style={{ fontSize: 10.5, color: "var(--fg-2)" }}>净增负债</span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)" }}>{v.flow.net >= 0 ? "+" : ""}{v.flow.net.toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 4 }}>负债总额 {v.flow.debt.toLocaleString()} ≈ ¥{Math.round(v.flow.debt / 10).toLocaleString()}</div>
        </ACard>
        <ACard title="今日转化漏斗">
          {v.funnel.map((f: V, i: number) => {
            const w = v.funnel[0].v > 0 ? Math.max(4, Math.round((f.v / v.funnel[0].v) * 100)) : 4;
            return (
              <div key={f.label} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{f.label}</span>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 700 }}>{f.v.toLocaleString()} <span style={{ color: "var(--fg-3)" }}>{f.pct}</span></span>
                </div>
                <div style={{ height: 6, background: "var(--inset)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: i < 2 ? "var(--home)" : "var(--gold)", width: `${w}%` }} />
                </div>
              </div>
            );
          })}
        </ACard>
      </div>
    </>
  );
}
