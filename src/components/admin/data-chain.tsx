"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ABtn, ACard, fmtT } from "./ui";

type StepStatus = "PASS" | "WARN" | "FAIL" | "OPEN";

interface Evidence {
  k: string;
  v: string | number | null;
}

interface ChainStep {
  key: string;
  title: string;
  status: StepStatus;
  reason: string;
  evidence: Evidence[];
}

interface ChainCheck {
  title: string;
  status: StepStatus;
  reason: string;
  evidence: Evidence[];
}

interface Candidate {
  fixtureId: number;
  match: string;
  league: string;
  kickoffUtc: number;
  status: string;
  score: string | null;
}

interface MarketDiag {
  reason?: string;
  selectedBooks?: number;
  line?: number | null;
  series?: unknown[];
  warnings?: string[];
}

interface DataChainDiag {
  fixture: {
    fixtureId: number;
    match: string;
    league: string;
    round: string;
    kickoffUtc: number;
    status: string;
    score: string | null;
  };
  steps: ChainStep[];
  checks: ChainCheck[];
  hiddenBreaks: string[];
  dangerous: string[];
  raw: {
    counts: Record<string, { n: number; m: number | null }>;
    prematch: {
      at: number | null;
      afRawAt: number | null;
      scan: { bookmakers: number; bets: number; ids: Record<string, string[]>; samples: Record<string, string[]> } | null;
      parserIssues: unknown[];
      samples: string[];
    };
    live: {
      at: number | null;
      bets: { id: number | null; name: string; values: number }[];
      frames: unknown[];
      parserIssues: unknown[];
    };
  };
  storage: { snapshots: Record<string, { n: number; books?: number; m: number | null }>; liveSnapshots: Record<string, { n: number; m: number | null }>; details: Record<string, number> };
  main: { selectedReasons: string[]; warnings: string[]; markets: Record<"ah" | "ou" | "eu", MarketDiag> };
  view: { statsRows: number; timelineRows: number; lineupsReady: boolean; extraMarkets: string[]; predictionReady: boolean };
  report: { predictions: { n: number; m: number | null }; versions: { n: number; m: number | null }; cache: { n: number; m: number | null }; cutoffAt: number; cutoffQuality: number };
  diagnostics: { status: StepStatus; text: string; at: number }[];
}

interface Payload {
  ok: boolean;
  candidates: Candidate[];
  diag: DataChainDiag | null;
  error?: string;
}

const statusStyle: Record<StepStatus, { fg: string; bg: string; bd: string; label: string }> = {
  PASS: { fg: "var(--green)", bg: "var(--success-bg)", bd: "var(--success-border)", label: "PASS" },
  WARN: { fg: "var(--warn)", bg: "var(--warn-bg)", bd: "var(--warn-border)", label: "WARN" },
  FAIL: { fg: "var(--red)", bg: "var(--danger-bg)", bd: "var(--danger-border)", label: "FAIL" },
  OPEN: { fg: "var(--fg-3)", bg: "var(--inset)", bd: "var(--line)", label: "OPEN" },
};

function StatusPill({ status }: { status: StepStatus }) {
  const s = statusStyle[status];
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 52,
        height: 22,
        borderRadius: 7,
        border: `1px solid ${s.bd}`,
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 900,
      }}
    >
      {s.label}
    </span>
  );
}

function EvidenceView({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 9 }}>
      {evidence.map((e) => (
        <span
          key={`${e.k}:${e.v}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: "var(--inset)",
            border: "1px solid var(--line-soft)",
            borderRadius: 7,
            padding: "4px 7px",
            fontSize: 10.5,
            color: "var(--fg-2)",
            maxWidth: "100%",
          }}
        >
          <span style={{ color: "var(--fg-3)" }}>{e.k}</span>
          <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.v ?? "—"}</span>
        </span>
      ))}
    </div>
  );
}

function StepCard({ item }: { item: ChainStep }) {
  return (
    <div style={{ border: "1px solid var(--line-soft)", background: "var(--card)", borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusPill status={item.status} />
        <div style={{ fontSize: 13, fontWeight: 900 }}>{item.title}</div>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.55, marginTop: 8 }}>{item.reason}</div>
      <EvidenceView evidence={item.evidence} />
    </div>
  );
}

function CheckRow({ item }: { item: ChainCheck }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--line-soft)", alignItems: "start" }}>
      <StatusPill status={item.status} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 900 }}>{item.title}</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.55, marginTop: 5 }}>{item.reason}</div>
        <EvidenceView evidence={item.evidence} />
      </div>
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: string | number; tone?: StepStatus }) {
  const color = tone ? statusStyle[tone].fg : "var(--fg)";
  return (
    <div style={{ border: "1px solid var(--line-soft)", background: "var(--inset)", borderRadius: 10, padding: "11px 12px" }}>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8 }}>{label}</div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 900, color }}>{value}</div>
    </div>
  );
}

function ListBlock({ title, rows, empty, tone }: { title: string; rows: string[]; empty: string; tone?: StepStatus }) {
  const color = tone ? statusStyle[tone].fg : "var(--fg-2)";
  return (
    <ACard title={title}>
      {rows.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((r, i) => (
            <div key={`${r}:${i}`} style={{ display: "flex", gap: 8, fontSize: 12, color, lineHeight: 1.55 }}>
              <span className="mono" style={{ color: "var(--fg-3)" }}>{i + 1}</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{empty}</div>
      )}
    </ACard>
  );
}

function MarketLine({ name, market }: { name: string; market?: MarketDiag }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "74px 1fr 82px", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <span style={{ fontSize: 12, fontWeight: 900 }}>{name}</span>
      <span style={{ minWidth: 0, fontSize: 11.5, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{market?.reason || market?.warnings?.[0] || "暂无主线"}</span>
      <span className="mono" style={{ textAlign: "right", color: "var(--fg-3)", fontSize: 11 }}>{market?.selectedBooks ?? 0} books</span>
    </div>
  );
}

function RawCounts({ diag }: { diag: DataChainDiag }) {
  const rows = Object.entries(diag.raw.counts);
  return (
    <ACard title="raw 入库计数" pad={false}>
      {rows.map(([k, r]) => (
        <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 70px 100px", padding: "10px 14px", borderBottom: "1px solid var(--line-soft)", alignItems: "center", fontSize: 12 }}>
          <span className="mono">{k}</span>
          <span className="mono" style={{ textAlign: "right", fontWeight: 900 }}>{r.n}</span>
          <span style={{ textAlign: "right", color: "var(--fg-3)", fontSize: 11 }}>{fmtT(r.m)}</span>
        </div>
      ))}
    </ACard>
  );
}

function CandidateList({ rows, onPick }: { rows: Candidate[]; onPick: (id: number) => void }) {
  return (
    <ACard title="最近可诊断比赛" pad={false}>
      <div style={{ display: "grid", gridTemplateColumns: "90px 1.2fr .8fr 110px 70px 60px", gap: 10, padding: "9px 14px", borderBottom: "1px solid var(--line)", color: "var(--fg-3)", fontSize: 11 }}>
        <span>fixture</span><span>比赛</span><span>赛事</span><span>时间</span><span>状态</span><span style={{ textAlign: "right" }}>操作</span>
      </div>
      {rows.map((r) => (
        <div key={r.fixtureId} style={{ display: "grid", gridTemplateColumns: "90px 1.2fr .8fr 110px 70px 60px", gap: 10, padding: "11px 14px", borderBottom: "1px solid var(--line-soft)", alignItems: "center", fontSize: 12 }}>
          <span className="mono" style={{ color: "var(--fg-3)" }}>{r.fixtureId}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 800 }}>{r.match}{r.score ? ` ${r.score}` : ""}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fg-2)" }}>{r.league}</span>
          <span style={{ color: "var(--fg-3)" }}>{fmtT(r.kickoffUtc)}</span>
          <span className="mono" style={{ color: "var(--fg-2)" }}>{r.status}</span>
          <button
            onClick={() => onPick(r.fixtureId)}
            style={{ border: "1px solid var(--line)", background: "var(--card)", color: "var(--fg)", borderRadius: 7, padding: "5px 8px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}
          >
            诊断
          </button>
        </div>
      ))}
      {rows.length === 0 && <div style={{ padding: 28, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>暂无匹配比赛</div>}
    </ACard>
  );
}

export function DataChainView({ fixtureId }: { fixtureId?: number | null }) {
  const [selected, setSelected] = useState(fixtureId ?? 0);
  const [input, setInput] = useState(fixtureId ? String(fixtureId) : "");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async (id = selected) => {
    setLoading(true);
    setMsg("");
    try {
      const url = id ? `/api/admin/data-chain?fixtureId=${id}` : "/api/admin/data-chain";
      const j = await fetch(url, { cache: "no-store" }).then((r) => r.json()) as Payload;
      setData(j);
      if (!j.ok) setMsg(j.error || "读取失败");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    if (fixtureId && fixtureId !== selected) {
      setSelected(fixtureId);
      setInput(String(fixtureId));
    }
  }, [fixtureId, selected]);

  useEffect(() => {
    void load(selected);
  }, [load, selected]);

  const candidates = useMemo(() => {
    const s = query.trim().toLowerCase();
    const rows = data?.candidates ?? [];
    if (!s) return rows.slice(0, 80);
    return rows.filter((r) => `${r.fixtureId} ${r.match} ${r.league} ${r.status}`.toLowerCase().includes(s)).slice(0, 80);
  }, [data?.candidates, query]);

  const diag = data?.diag ?? null;
  const statusCounts = useMemo(() => {
    const counts: Record<StepStatus, number> = { PASS: 0, WARN: 0, FAIL: 0, OPEN: 0 };
    for (const item of [...(diag?.steps ?? []), ...(diag?.checks ?? [])]) counts[item.status]++;
    return counts;
  }, [diag]);

  const submit = () => {
    const id = Number(input.trim());
    if (!Number.isFinite(id) || id <= 0) {
      setSelected(0);
      void load(0);
      return;
    }
    setSelected(id);
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>数据链路诊断</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>单场复盘 AF raw → parser → 主盘口 → 视图 → 用户端 → 报告引用</div>
        </div>
        <span style={{ flex: 1 }} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="输入 fixture id"
          className="mono"
          style={{ width: 170, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px", color: "var(--fg)", outline: "none", fontSize: 12 }}
        />
        <ABtn label={loading ? "诊断中" : "诊断"} kind="line" onClick={submit} />
        <ABtn label="刷新" kind="line" onClick={() => void load(selected)} />
      </div>

      {msg && <div style={{ fontSize: 12, color: "var(--red)" }}>{msg}</div>}

      {!diag && (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索 fixture / 比赛 / 联赛 / 状态"
            style={{ width: 360, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px", color: "var(--fg)", outline: "none", fontSize: 12 }}
          />
          <CandidateList rows={candidates} onPick={(id) => { setInput(String(id)); setSelected(id); }} />
        </>
      )}

      {diag && (
        <>
          <ACard>
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr repeat(4, 110px)", gap: 12, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                  <span className="mono" style={{ color: "var(--fg-3)", fontSize: 12 }}>{diag.fixture.fixtureId}</span>
                  <span style={{ fontSize: 16, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{diag.fixture.match}</span>
                  {diag.fixture.score && <span className="mono" style={{ color: "var(--red)", fontSize: 14, fontWeight: 900 }}>{diag.fixture.score}</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 6 }}>{diag.fixture.league} · {diag.fixture.round || "—"} · {fmtT(diag.fixture.kickoffUtc)} · {diag.fixture.status}</div>
              </div>
              <SummaryMetric label="PASS" value={statusCounts.PASS} tone="PASS" />
              <SummaryMetric label="WARN" value={statusCounts.WARN} tone="WARN" />
              <SummaryMetric label="FAIL" value={statusCounts.FAIL} tone="FAIL" />
              <SummaryMetric label="OPEN" value={statusCounts.OPEN} tone="OPEN" />
            </div>
          </ACard>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.08fr) minmax(0, .92fr)", gap: 14, alignItems: "start" }}>
            <ACard title="完整拟合链路">
              <div style={{ display: "grid", gap: 10 }}>
                {diag.steps.map((s) => <StepCard key={s.key} item={s} />)}
              </div>
            </ACard>
            <div style={{ display: "grid", gap: 14 }}>
              <ACard title="专项检查" pad={false}>
                {diag.checks.map((c) => <CheckRow key={c.title} item={c} />)}
              </ACard>
              <ListBlock title="AF 有数据但用户端没展示" rows={diag.hiddenBreaks} empty="未发现断点" tone="WARN" />
              <ListBlock title="用户端展示但无真实来源" rows={diag.dangerous} empty="未发现危险模块" tone="FAIL" />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
            <RawCounts diag={diag} />
            <ACard title="主盘口选择说明">
              <MarketLine name="亚盘" market={diag.main.markets.ah} />
              <MarketLine name="大小" market={diag.main.markets.ou} />
              <MarketLine name="胜平负" market={diag.main.markets.eu} />
              {diag.main.selectedReasons.length > 0 && (
                <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                  {diag.main.selectedReasons.map((r) => <div key={r} style={{ fontSize: 11.5, color: "var(--fg-2)", lineHeight: 1.5 }}>{r}</div>)}
                </div>
              )}
              {diag.main.warnings.length > 0 && (
                <div style={{ marginTop: 10, color: "var(--warn)", fontSize: 11.5, lineHeight: 1.55 }}>{diag.main.warnings.join("；")}</div>
              )}
            </ACard>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
            <ACard title="parser 重放">
              <div style={{ display: "grid", gap: 8, fontSize: 12, color: "var(--fg-2)" }}>
                <div>赛前 raw: <span className="mono">{fmtT(diag.raw.prematch.at)}</span> · af_raw: <span className="mono">{fmtT(diag.raw.prematch.afRawAt)}</span></div>
                <div>bookmakers: <span className="mono">{diag.raw.prematch.scan?.bookmakers ?? 0}</span> · bets: <span className="mono">{diag.raw.prematch.scan?.bets ?? 0}</span> · parser issues: <span className="mono">{diag.raw.prematch.parserIssues.length}</span></div>
                <div>EU ids: <span className="mono">{diag.raw.prematch.scan?.ids.eu.join(", ") || "—"}</span></div>
                <div>AH ids: <span className="mono">{diag.raw.prematch.scan?.ids.ah.join(", ") || "—"}</span></div>
                <div>OU ids: <span className="mono">{diag.raw.prematch.scan?.ids.ou.join(", ") || "—"}</span></div>
                {diag.raw.prematch.samples.slice(0, 6).map((s) => (
                  <div key={s} className="mono" style={{ fontSize: 11, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s}</div>
                ))}
              </div>
            </ACard>
            <ACard title="滚球 raw / live parser">
              <div style={{ display: "grid", gap: 8, fontSize: 12, color: "var(--fg-2)" }}>
                <div>latest live raw: <span className="mono">{fmtT(diag.raw.live.at)}</span> · frames: <span className="mono">{diag.raw.live.frames.length}</span> · issues: <span className="mono">{diag.raw.live.parserIssues.length}</span></div>
                {diag.raw.live.bets.length > 0 ? diag.raw.live.bets.map((b) => (
                  <div key={`${b.id}:${b.name}`} style={{ display: "grid", gridTemplateColumns: "70px 1fr 70px", gap: 8 }}>
                    <span className="mono">{b.id ?? "—"}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name || "未命名"}</span>
                    <span className="mono" style={{ textAlign: "right" }}>{b.values} values</span>
                  </div>
                )) : <div style={{ color: "var(--fg-3)" }}>暂无滚球 raw 候选</div>}
              </div>
            </ACard>
          </div>

          <ACard title="视图与报告引用">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
              <SummaryMetric label="技术统计行" value={diag.view.statsRows} />
              <SummaryMetric label="赛况时间线" value={diag.view.timelineRows} />
              <SummaryMetric label="阵容视图" value={diag.view.lineupsReady ? "ready" : "empty"} tone={diag.view.lineupsReady ? "PASS" : "OPEN"} />
              <SummaryMetric label="更多玩法" value={diag.view.extraMarkets.length} />
              <SummaryMetric label="报告版本" value={diag.report.versions.n} />
              <SummaryMetric label="cutoff 质量" value={diag.report.cutoffQuality} />
            </div>
            {diag.diagnostics.length > 0 && (
              <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                {diag.diagnostics.map((d, i) => (
                  <div key={`${d.text}:${i}`} style={{ display: "grid", gridTemplateColumns: "72px 1fr 100px", gap: 10, alignItems: "center", fontSize: 11.5, color: "var(--fg-2)" }}>
                    <StatusPill status={d.status} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.text}</span>
                    <span style={{ textAlign: "right", color: "var(--fg-3)" }}>{fmtT(d.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </ACard>
        </>
      )}
    </div>
  );
}
