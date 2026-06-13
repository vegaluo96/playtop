"use client";

/** 风控与审计 / 工单处理 / 数据与模型监控 / 系统设置(四个系统模块) */
import { aAlert, aConfirm, aPrompt } from "./dialogs";
import { useCallback, useEffect, useState } from "react";
import { ABtn, ACard, AChip, AGrid, AInput, Th, fmtT, post, val } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export function RiskView() {
  const [v, setV] = useState<V | null>(null);
  const load = useCallback(() => fetch("/api/admin/risk").then((r) => r.json()).then((j) => j.ok && setV(j)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (id: number, decision: string) => {
    const j = await post("/api/admin/risk", { id, decision });
    if (!j.ok) void aAlert(j.error);
    void load();
  };
  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>风控与审计</div>
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14, alignItems: "start" }}>
        <ACard title={<span>风控队列 {v?.queue?.length > 0 && <span style={{ fontSize: 11, fontWeight: 800, background: "var(--danger-bg)", color: "var(--red)", borderRadius: 8, padding: "1px 6px", marginLeft: 4 }}>{v.queue.length}</span>}</span>} pad={false}>
        {(v?.queue ?? []).length === 0 && <div style={{ padding: 14, fontSize: 11.5, color: "var(--fg-3)" }}>队列为空(规则:同 IP 邀请聚集 / 注册即大额购买 / 同 IP 批量领码)</div>}
        {(v?.queue ?? []).map((r: V) => (
          <div key={r.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{fmtT(r.at)}</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: r.type === "自邀嫌疑" ? "var(--red)" : "var(--gold)" }}>{r.type}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--fg-2)" }}>风险分 <span className="mono" style={{ fontWeight: 800, color: "var(--red)" }}>{r.score}</span></span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.detail}</span>
              <ABtn small kind="red" label="拦截" onClick={async () => (await aConfirm(`拦截:${r.detail}`)) && void decide(r.id, "拦截")} />
              <ABtn small kind="green" label="放行" onClick={() => void decide(r.id, "放行")} />
            </div>
          </div>
        ))}
          <div style={{ padding: "9px 14px", fontSize: 11, color: "var(--fg-3)" }}>命中即入队待人工裁决;拦截会将用户标记为「风控」并写审计</div>
        </ACard>
        <ACard title="操作审计日志" pad={false}>
          {(v?.audits ?? []).map((a: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", flexShrink: 0 }}>{fmtT(a.at)}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--home)", flexShrink: 0 }}>{a.actor}</span>
              <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.action}{a.detail ? ` · ${a.detail}` : ""}</span>
            </div>
          ))}
          <div style={{ padding: "9px 14px", fontSize: 11, color: "var(--fg-3)" }}>所有后台写操作强制留痕,不可删除</div>
        </ACard>
      </div>
    </>
  );
}

export function TicketsView() {
  const [rows, setRows] = useState<V[]>([]);
  const [f, setF] = useState("处理中");
  const [selId, setSelId] = useState<number | null>(null);
  const load = useCallback(() => fetch(`/api/admin/tickets?f=${encodeURIComponent(f)}`).then((r) => r.json()).then((j) => j.ok && setRows(j.rows)), [f]);
  useEffect(() => {
    void load();
  }, [load]);
  const sel = rows.find((t) => t.id === selId) ?? rows[0];

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>工单处理</span>
        <span style={{ flex: 1 }} />
        {["处理中", "已回复", "全部"].map((l) => (
          <AChip key={l} label={l} active={f === l} onClick={() => setF(l)} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.1fr", gap: 14, alignItems: "start" }}>
        <ACard pad={false}>
          {rows.length === 0 && <div style={{ padding: 14, fontSize: 11.5, color: "var(--fg-3)" }}>暂无工单</div>}
          {rows.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelId(t.id)}
              style={{ padding: "11px 14px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer", borderLeft: `3px solid ${sel?.id === t.id ? "var(--gold)" : "transparent"}`, background: sel?.id === t.id ? "var(--selected-bg-soft)" : "transparent" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>T{t.id}</span>
                <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{t.type}</span>
                <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 4, padding: "2px 7px", background: t.status === "处理中" ? "var(--selected-bg)" : "var(--success-bg)", color: t.status === "处理中" ? "var(--gold)" : "var(--green)" }}>{t.status}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <span style={{ fontSize: 11, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.body}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", flexShrink: 0 }}>{fmtT(t.created_at)}</span>
              </div>
            </div>
          ))}
        </ACard>
        {sel ? (
          <ACard>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>T{sel.id}</span>
              <span style={{ fontSize: 13, fontWeight: 800, flex: 1 }}>{sel.type}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{sel.email}</span>
            </div>
            <div style={{ background: "var(--inset)", borderRadius: 9, padding: "11px 13px", fontSize: 12, color: "var(--fg-mid)", lineHeight: 1.7, marginBottom: 12 }}>{sel.body}</div>
            {sel.reply && (
              <div style={{ background: "var(--success-bg-soft)", border: "1px solid var(--success-border)", borderRadius: 9, padding: "9px 13px", fontSize: 11, color: "var(--fg-mid)", lineHeight: 1.6, marginBottom: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "var(--green)", marginRight: 6 }}>已回复</span>{sel.reply}
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 6 }}>回复用户</div>
            <textarea id="tk-reply" rows={4} placeholder="输入回复内容,将显示在用户的工单列表…" style={{ width: "100%", boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 9, padding: 11, fontSize: 12, color: "var(--fg)", outline: "none", resize: "none", lineHeight: 1.6 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <span style={{ flex: 1 }}>
                <ABtn label="回复并标记已解决" onClick={async () => {
                  const text = val("tk-reply");
                  if (!text) return void aAlert("回复内容为空");
                  const j = await post("/api/admin/tickets", { action: "reply", id: sel.id, text });
                  if (!j.ok) void aAlert(j.error);
                  void load();
                }} />
              </span>
              <ABtn kind="line" label="补偿额度" onClick={async () => {
                const pts = Number(await aPrompt("补偿额度(客服 ≤100):") ?? 0);
                if (!(pts > 0)) return;
                const reason = await aPrompt("补偿原因:") ?? "";
                const j = await post("/api/admin/tickets", { action: "compensate", id: sel.id, points: pts, reason });
                if (!j.ok) void aAlert(j.error);
                else void aAlert("已补偿");
              }} />
            </div>
          </ACard>
        ) : (
          <div />
        )}
      </div>
    </>
  );
}

export function DataMonView() {
  const [v, setV] = useState<V | null>(null);
  const load = useCallback(() => fetch("/api/admin/monitor").then((r) => r.json()).then((j) => j.ok && setV(j)), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);
  if (!v) return <div style={{ color: "var(--fg-3)", fontSize: 12, padding: 40, textAlign: "center" }}>加载中…</div>;
  const statusColor = (s: string) => (s === "正常" ? "var(--green)" : s === "慢" ? "var(--gold)" : "var(--red)");
  const snapStatusColor = (s: string) => (s === "断档" ? "var(--red)" : s === "连续" || s === "有记录" ? "var(--green)" : "var(--fg-3)");
  const intervalText = (ms: number) => (ms >= 3_600_000 ? `巡检 / ${Math.round(ms / 3_600_000)}h` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
  const emergency = v.emergencyState ?? { manual: v.emergency, auto: false, active: v.emergency, pct: null };
  const shortUrl = (url: string) => {
    try {
      const u = new URL(url);
      return u.host;
    } catch {
      return url;
    }
  };

  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>
        数据与模型监控 <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 400 }}>· AF 端点调度 · 其他端点 · 快照归档 · AI 报告服务</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ACard title="AF 端点" pad={false}>
            <AGrid cols="1fr 100px 100px 64px 64px" head>
              <Th t="端点" /><Th t="分层" /><Th t="上次抓取" /><Th t="耗时" right /><Th t="状态" center />
            </AGrid>
            {(v.eps ?? []).length === 0 && <div style={{ padding: 14, fontSize: 11.5, color: "var(--fg-3)" }}>等待 worker 上报(启动后自动出现)</div>}
            {(v.eps ?? []).map((e: V) => (
              <AGrid key={e.k} cols="1fr 100px 100px 64px 64px">
                <span className="mono" style={{ fontSize: 11 }}>{e.k}</span>
                <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{e.tier}</span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{fmtT(e.last_at).slice(6)}</span>
                <span className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--fg-2)" }}>{e.ms != null ? `${e.ms}ms` : "—"}</span>
                <span style={{ fontSize: 11, fontWeight: 800, textAlign: "center", color: statusColor(e.status) }}>{e.status}</span>
              </AGrid>
            ))}
            <div style={{ padding: "9px 14px", fontSize: 11, color: "var(--fg-3)" }}>AF 主数据源抓取链路;只展示 worker 实际调度和回源状态。</div>
          </ACard>
          <ACard title="其他端点" pad={false}>
            <AGrid cols="1fr 96px 92px 64px 64px" head>
              <Th t="来源" /><Th t="用途" /><Th t="上次探测" /><Th t="耗时" right /><Th t="状态" center />
            </AGrid>
            {(v.externalEndpoints ?? []).length === 0 && <div style={{ padding: 14, fontSize: 11.5, color: "var(--fg-3)" }}>暂无其他端点配置</div>}
            {(v.externalEndpoints ?? []).map((e: V) => (
              <AGrid key={e.k} cols="1fr 96px 92px 64px 64px">
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 11.5, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.k}</span>
                  <span className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--fg-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{shortUrl(e.url)}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{e.kind}</span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{fmtT(e.last_at).slice(6)}</span>
                <span className="mono" style={{ fontSize: 11.5, textAlign: "right", color: "var(--fg-2)" }}>{e.ms != null ? `${e.ms}ms` : "—"}</span>
                <span title={e.note} style={{ fontSize: 11, fontWeight: 800, textAlign: "center", color: statusColor(e.status) }}>{e.status}</span>
              </AGrid>
            ))}
            <div style={{ padding: "9px 14px", fontSize: 11, color: "var(--fg-3)" }}>Polymarket、天气与后续扩展源统一在这里查看;探测结果缓存 10 分钟,不参与 AF 抓取频率。</div>
          </ACard>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <ACard title="快照归档(今日)">
            {v.snaps.map((s: V) => (
              <div key={s.k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span className="mono" style={{ flex: 1, fontSize: 11 }}>{s.k}</span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{s.n.toLocaleString()} 条</span>
                <span className="mono" style={{ width: 40, fontSize: 11, color: "var(--fg-3)", textAlign: "right" }}>{s.lastAt ? fmtT(s.lastAt).slice(6) : "—"}</span>
                <span title={s.note} style={{ width: 38, fontSize: 11, fontWeight: 800, textAlign: "right", color: snapStatusColor(s.status) }}>{s.status}</span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 8 }}>只在存在应抓赛事且超过当前档位宽限未入库时标断档;预测与异动不是连续流。</div>
            <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 8, marginTop: 8 }}>
              <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 4 }}>扩展玩法解析(最近未完场样本)</div>
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: v.extraMarkets ? "var(--green)" : "var(--fg-3)" }}>
                {v.extraMarkets ? `${v.extraMarkets.fixture}:${v.extraMarkets.kinds.length} 种 · ${v.extraMarkets.kinds.join(" / ")}` : "暂无样本(待开盘归档)"}
              </div>
            </div>
          </ACard>
          <ACard title="主盘口决策">
            {(v.marketDecision ?? []).length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>暂无可诊断场次</div>}
            {(v.marketDecision ?? []).map((m: V) => (
              <div key={m.market} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className="mono" style={{ width: 26, fontSize: 11, fontWeight: 800 }}>{m.market}</span>
                  <span className="mono" style={{ fontSize: 11, color: m.qualityScore >= 85 ? "var(--green)" : m.qualityScore >= 70 ? "var(--gold)" : "var(--red)", fontWeight: 800 }}>{m.qualityScore}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>覆盖 {m.selectedBooks}/{m.books} · 主流 {m.primaryBooks}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-mid)", lineHeight: 1.45 }}>{m.reason}</div>
                {(m.warnings ?? []).length > 0 && <div style={{ fontSize: 10.5, color: "var(--gold)", marginTop: 3 }}>{m.warnings.join(" / ")}</div>}
              </div>
            ))}
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 8 }}>按最近未完场比赛抽样;用于排查主盘口选择,不直接改写原始 AF 数据。</div>
          </ACard>
          <ACard
            title="AF 抓取频率配置"
            right={<ABtn small kind="line" label="编辑" onClick={async () => {
              const cur = v.intervals.map((x: V) => Math.round(x.ms / 1000)).join(",");
              const next = await aPrompt("各档间隔(秒,逗号分隔;滚球两档可至 5,其余下限 60):", cur);
              if (!next || next === cur) return;
              if (!await aConfirm(`抓取频率 → ${next}(秒)`)) return;
              const j = await post("/api/admin/monitor", { action: "intervals", values: next.split(",").map((x) => Number(x.trim()) * 1000) });
              if (!j.ok) void aAlert(j.error);
              void load();
            }} />}
          >
            {v.intervals.map((t: V) => (
              <div key={t.label} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{t.label}</span>
                <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: (t.effectiveMs ?? t.ms) <= 60_000 ? "var(--gold)" : undefined, textAlign: "right" }}>
                  {intervalText(t.ms)}
                  {t.effectiveMs != null && t.effectiveMs !== t.ms && <span style={{ color: "var(--red)" }}> → {intervalText(t.effectiveMs)}</span>}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0 0" }}>
              <span style={{ fontSize: 11.5, color: "var(--fg-2)" }}>紧急降频模式(手动或配额 ≥95% 自动)</span>
              <span
                onClick={async () => {
                  if (!await aConfirm(`手动紧急降频 → ${emergency.manual ? "关" : "开"}(全档位 ×2; 自动触发不受此开关影响)`)) return;
                  await post("/api/admin/monitor", { action: "emergency", on: !emergency.manual });
                  void load();
                }}
                style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", color: emergency.active ? "var(--red)" : "var(--fg-3)", border: "1px solid var(--line)", borderRadius: 999, padding: "2px 10px" }}
              >
                {emergency.manual ? "手动开" : emergency.auto ? "自动生效" : "关"}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 8 }}>
              {emergency.active ? `当前实际全档位 ×2${emergency.auto && emergency.pct != null ? ` · AF 已用 ${emergency.pct}%` : ""}` : "未触发;85% 只提醒观察,95% 才自动保护"}。改动即时下发调度器并写审计;滚球两档可低至 5s,其余档下限 1 min
            </div>
          </ACard>
          <ACard title="AI 报告服务" right={<span style={{ fontSize: 11, fontWeight: 700, color: v.llm.configured ? "var(--green)" : "var(--fg-3)" }}>{v.llm.configured ? "运行正常" : "模板模式"}</span>}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              {[[v.llm.count, "今日生成"], [`${v.llm.count + v.llm.hits > 0 ? Math.round((v.llm.hits / (v.llm.count + v.llm.hits)) * 100) : 0}%`, "缓存命中"], [`${(v.llm.tokens / 1e6).toFixed(2)}M`, "tokens 已用"], [v.llm.fails, "失败次数"]].map(([n, label]) => (
                <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "9px 0", textAlign: "center" }}>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 800 }}>{n as string}</div>
                  <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{label as string}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.7 }}>策略:同场报告生成一次全员复用,指数变化超阈值才重生成;tokens 达预算 100% 自动降级为模板报告。</div>
          </ACard>
          <ACard title="急变事件(近 1 小时)">
            {(v.alerts ?? []).length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>近 1 小时无急变</div>}
            {(v.alerts ?? []).map((a: V, i: number) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{a.t}</span>
                <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.x}</span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: a.up ? "var(--up)" : "var(--down)" }}>{a.d}</span>
              </div>
            ))}
          </ACard>
          <ACard title="盘口适配诊断">
            {v.diagnosticSummary && (
              <div style={{ marginBottom: 10, display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--inset)", borderRadius: 8, padding: "7px 9px" }}>
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>近 24h 拦截</span>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 800 }}>{v.diagnosticSummary.total ?? 0}</span>
                </div>
                {(v.diagnosticSummary.byType ?? []).slice(0, 3).map((x: V) => (
                  <div key={`${x.error_type}-${x.severity}`} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10.5, color: "var(--fg-3)" }}>
                    <span style={{ width: 48, color: x.severity === "error" ? "var(--red)" : x.severity === "warn" ? "var(--gold)" : "var(--fg-3)", fontWeight: 800 }}>{x.severity}</span>
                    <span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.error_type}</span>
                    <span className="mono" style={{ fontWeight: 800 }}>{x.n}</span>
                  </div>
                ))}
                {(v.diagnosticSummary.byFixture ?? []).slice(0, 3).map((x: V) => (
                  <div key={`fx-${x.fixture_id ?? "none"}`} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10.5, color: "var(--fg-3)" }}>
                    <span>fixture</span>
                    <span className="mono" style={{ flex: 1 }}>{x.fixture_id ?? "—"}</span>
                    <span className="mono" style={{ fontWeight: 800 }}>{x.n}</span>
                  </div>
                ))}
              </div>
            )}
            {(v.diagnostics ?? []).length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>暂无拦截记录</div>}
            {(v.diagnostics ?? []).map((d: V) => (
              <div key={d.issue_id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{fmtT(d.created_at).slice(6)}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{d.endpoint}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: d.severity === "error" ? "var(--red)" : d.severity === "warn" ? "var(--gold)" : "var(--fg-3)" }}>{d.error_type}</span>
                  <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--fg-3)" }}>{d.fixture_id ?? "—"}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-mid)", lineHeight: 1.45, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.error_reason}</div>
                {d.raw_value && <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.raw_value}</div>}
              </div>
            ))}
          </ACard>
        </div>
      </div>
    </>
  );
}

export function SettingsView() {
  const [v, setV] = useState<V | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => fetch("/api/admin/settings").then((r) => r.json()).then((j) => j.ok && setV(j)), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!v) return <div style={{ color: "var(--fg-3)", fontSize: 12, padding: 40, textAlign: "center" }}>加载中…</div>;

  const setKey = async (which: string, label: string) => {
    const value = await aPrompt(`输入新的 ${label}(仅保存在服务端,不回显明文):`);
    if (!value) return;
    if (!await aConfirm(`更换 ${label}`)) return;
    const j = await post("/api/admin/settings", { action: "set_key", which, value });
    if (!j.ok) void aAlert(j.error);
    void load();
  };
  const run = async (action: string, label: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      const j = await post("/api/admin/settings", { action, ...extra });
      void aAlert(j.ok ? `${label} 完成:${JSON.stringify(j).slice(0, 300)}` : `${label} 失败:${j.error}`);
      void load();
    } finally {
      setBusy("");
    }
  };
  const Row = ({ k, val: value }: { k: string; val: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderTop: "1px solid var(--line-soft)" }}>
      <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{k}</span>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{value}</span>
    </div>
  );
  const KeyRow = ({ masked, which, label }: { masked: string; which: string; label: string }) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
      <input value={masked} readOnly className="mono" style={{ flex: 1, minWidth: 0, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 12px", fontSize: 12, color: "var(--fg-2)", outline: "none" }} />
      <span onClick={() => void setKey(which, label)} style={{ flexShrink: 0, border: "1px solid var(--selected-border-strong)", color: "var(--gold)", borderRadius: 8, display: "flex", alignItems: "center", padding: "0 14px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>更换</span>
    </div>
  );

  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>
        系统设置 <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 400 }}>· 密钥仅存服务端,后台不回显明文;每次更新写入审计日志</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
        <ACard title="AF 密钥" right={<span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: v.af.connected ? "var(--green)" : "var(--red)", fontWeight: 700 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: v.af.connected ? "var(--green)" : "var(--red)" }} />{v.af.connected ? "已配置" : "未配置"}</span>}>
          <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 6 }}>API_FOOTBALL_KEY</div>
          <KeyRow masked={v.af.masked} which="af_key" label="AF 密钥" />
          <Row k="套餐(/status)" val={v.af.status ? `${v.af.status.plan ?? "—"} · ${v.af.status.limit?.toLocaleString() ?? "—"} req/日` : "—"} />
          <Row k="今日已用" val={v.af.status?.current != null ? `${v.af.status.current.toLocaleString()}(${v.af.status.limit ? Math.round((v.af.status.current / v.af.status.limit) * 100) : "—"}%)` : "—"} />
          <Row
            k="最近自检"
            val={
              v.af.lastSelftest
                ? `${fmtT(v.af.lastSelftest.at)} · ${(v.af.lastSelftest.reachable ?? ((v.af.lastSelftest.ok ?? 0) + (v.af.lastSelftest.empty ?? 0)))}/${v.af.lastSelftest.total} 可达 · 回数据 ${v.af.lastSelftest.ok ?? 0} · 空 ${v.af.lastSelftest.empty ?? 0} · 错误 ${v.af.lastSelftest.error ?? 0}`
                : "未运行"
            }
          />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <span style={{ flex: 1 }}><ABtn label={busy === "selftest" ? "自检运行中(约 30s)…" : "运行 selftest(消耗约 45 req)"} onClick={() => busy || void run("selftest", "selftest")} /></span>
            <ABtn kind="line" label="测试连接" onClick={() => void run("af_ping", "连接测试")} />
          </div>
          <div style={{ marginTop: 8 }}>
            <ABtn kind="line" label={busy === "platform_check" ? "体检中…" : "运行平台体检(只读+API 层,~2 req)"} onClick={() => busy || void run("platform_check", "平台体检")} />
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6 }}>全量闭环体检(含商业链路演练)在服务器跑:npm run selfcheck</div>
          </div>
        </ACard>
        <ACard title="大模型密钥(AI 报告)" right={<span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: v.llm.usage.configured ? "var(--green)" : "var(--fg-3)", fontWeight: 700 }}><span style={{ width: 5, height: 5, borderRadius: "50%", background: v.llm.usage.configured ? "var(--green)" : "var(--fg-3)" }} />{v.llm.usage.configured ? "已连接" : "模板模式"}</span>}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: "var(--fg-2)" }}>服务商:聚合网关</span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: v.llm.balanceDetail?.error ? "var(--gold)" : v.llm.balance != null && v.llm.balance < 100 ? "var(--red)" : "var(--green)" }}>
              {v.llm.balanceDetail?.error
                ? "余额查询失败"
                : v.llm.balance != null
                ? `余额 $${v.llm.balance}${v.llm.balanceDetail?.limit != null ? ` · 已用 $${v.llm.balanceDetail.used ?? 0}/$${v.llm.balanceDetail.limit}` : ""}`
                : "余额 —"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 6 }}>LLM_API_KEY(调用密钥)</div>
          <KeyRow masked={v.llm.keyMasked} which="llm_key" label="LLM 调用密钥" />
          <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 6 }}>BALANCE_QUERY_KEY(余额查询密钥 · 与调用密钥不同串)</div>
          <KeyRow masked={v.llm.balanceKeyMasked} which="llm_balance_key" label="余额查询密钥" />
          <Row k="报告模型" val={v.llm.model} />
          <Row k="网关地址" val={v.llm.base} />
          <Row k="日预算上限" val={`${(v.llm.budget / 1e6).toFixed(0)}M tokens`} />
          <Row k="超额策略" val="80% 告警 · 100% 降级模板报告" />
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <span style={{ flex: 1 }}><ABtn label={busy === "llm_test" ? "测试中…" : "发送测试请求"} onClick={() => busy || void run("llm_test", "LLM 测试")} /></span>
            <ABtn kind="line" label="改模型" onClick={() => void setKey("llm_model", "报告模型名")} />
            <ABtn kind="line" label="改预算" onClick={async () => {
              const value = await aPrompt("日预算(tokens):", String(v.llm.budget));
              if (value && await aConfirm(`日预算 → ${value}`)) {
                await post("/api/admin/settings", { action: "set_budget", value: Number(value) });
                void load();
              }
            }} />
          </div>
        </ACard>
      </div>

      <ACard title="管理员与权限" style={{ marginTop: 14 }} pad={false} right={<ABtn small kind="line" label="+ 邀请成员" onClick={async () => {
        const email = await aPrompt("成员邮箱(需先在前台注册):");
        if (!email) return;
        const role = await aPrompt("角色(超级管理员/运营/客服/风控):", "运营") ?? "运营";
        const j = await post("/api/admin/settings", { action: "member_add", email, role });
        if (!j.ok) void aAlert(j.error);
        void load();
      }} />}>
        <AGrid cols="1.4fr 110px 1.6fr 70px 130px" head>
          <Th t="成员" /><Th t="角色" /><Th t="权限范围" /><Th t="状态" center /><Th t="操作" right />
        </AGrid>
        {v.members.map((m: V) => {
          const scope: Record<string, string> = {
            超级管理员: "全部模块 · 密钥/封禁/补偿复核权",
            运营: "看板 / 赛事内容 / 营销配置 / 工单",
            客服: "工单处理 · 订单只读 · 小额补偿(≤100分)",
            风控: "风控审计 / 用户封禁 / 邀请结算裁决",
          };
          const roleC: Record<string, string> = { 超级管理员: "var(--gold)", 运营: "var(--home)", 客服: "var(--green)", 风控: "var(--red)" };
          const isSelf = m.role === "超级管理员" && v.members.filter((x: V) => x.role === "超级管理员").length === 1;
          return (
            <AGrid key={m.email} cols="1.4fr 110px 1.6fr 70px 130px">
              <span className="mono" style={{ fontSize: 11 }}>{m.email}</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: roleC[m.role] }}>{m.role}</span>
              <span style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{scope[m.role]}</span>
              <span style={{ fontSize: 11, fontWeight: 700, textAlign: "center", color: m.status === "启用" ? "var(--green)" : "var(--fg-3)" }}>{m.status}</span>
              <span style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                {isSelf ? (
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>不可修改</span>
                ) : (
                  <>
                    <ABtn small kind="line" label="改角色" onClick={async () => {
                      const role = await aPrompt("新角色(超级管理员/运营/客服/风控):", m.role);
                      if (role) {
                        await post("/api/admin/settings", { action: "member_set", email: m.email, role });
                        void load();
                      }
                    }} />
                    <ABtn small kind={m.status === "启用" ? "red" : "green"} label={m.status === "启用" ? "停用" : "启用"} onClick={async () => {
                      await post("/api/admin/settings", { action: "member_set", email: m.email, status: m.status === "启用" ? "停用" : "启用" });
                      void load();
                    }} />
                  </>
                )}
              </span>
            </AGrid>
          );
        })}
        <div style={{ padding: "9px 14px", fontSize: 11, color: "var(--fg-3)" }}>RBAC 由后端控制;敏感操作(密钥更换 / 封禁 / 补偿 &gt;100 分)需超级管理员,全部写审计日志</div>
      </ACard>
      <span style={{ display: "none" }}><AInput id="_x" /></span>
    </>
  );
}
