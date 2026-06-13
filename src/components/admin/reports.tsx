"use client";

import { useEffect, useMemo, useState } from "react";
import { ABtn, ACard, fmtT } from "./ui";

type SourceState = "ok" | "warn" | "missing" | "skipped";

interface SourceProbe {
  state: SourceState;
  label: string;
  note: string;
  count?: number;
  lastAt?: number | null;
}

interface ReportAdminRow {
  fixtureId: number;
  league: string;
  round: string;
  kickoffUtc: number;
  statusText: string;
  locked: boolean;
  match: string;
  score: string | null;
  report: {
    generated: boolean;
    cacheReady: boolean;
    versionCount: number;
    latestVersion: number | null;
    generatedAt: number | null;
    model: string;
    tokens: number;
    changed: string[];
    summary: string;
    algorithmVersion: string;
  };
  access: { free: boolean; unlocks: number; lockedForUsers: boolean };
  sources: Record<string, SourceProbe>;
  missingInputs: string[];
  failureReason: string;
  canRegenerate: boolean;
}

interface ReportsPayload {
  ok: boolean;
  summary: { total: number; generated: number; cacheReady: number; missing: number; locked: number; needsInput: number; failed: number };
  rows: ReportAdminRow[];
  error?: string;
}

const stateStyle: Record<SourceState, { fg: string; bg: string; bd: string; label: string }> = {
  ok: { fg: "var(--green)", bg: "var(--success-bg)", bd: "var(--success-border)", label: "有" },
  warn: { fg: "var(--warn)", bg: "var(--warn-bg)", bd: "var(--warn-border)", label: "警告" },
  missing: { fg: "var(--red)", bg: "var(--danger-bg)", bd: "var(--danger-border)", label: "缺" },
  skipped: { fg: "var(--fg-3)", bg: "var(--inset)", bd: "var(--line)", label: "未用" },
};

function Stat({ k, v, tone }: { k: string; v: number; tone?: "red" | "green" | "warn" }) {
  const color = tone === "red" ? "var(--red)" : tone === "green" ? "var(--green)" : tone === "warn" ? "var(--warn)" : "var(--fg)";
  return (
    <div style={{ background: "var(--inset)", border: "1px solid var(--line-soft)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 8 }}>{k}</div>
      <div className="mono" style={{ fontSize: 21, fontWeight: 900, color }}>{v}</div>
    </div>
  );
}

function Badge({ state, text, title }: { state: SourceState; text?: string; title?: string }) {
  const s = stateStyle[state];
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 22,
        borderRadius: 7,
        padding: "0 7px",
        border: `1px solid ${s.bd}`,
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 800,
        whiteSpace: "nowrap",
      }}
    >
      {text ?? s.label}
    </span>
  );
}

function SourcePills({ sources }: { sources: Record<string, SourceProbe> }) {
  const keys = [
    ["predictions", "预测"],
    ["oddsAh", "亚"],
    ["oddsOu", "大"],
    ["statistics", "统"],
    ["lineups", "阵"],
    ["injuries", "伤"],
    ["polymarket", "PM"],
    ["weather", "天"],
  ] as const;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {keys.map(([k, label]) => {
        const src = sources[k];
        return src ? <Badge key={k} state={src.state} text={`${label}:${stateStyle[src.state].label}`} title={`${src.label}: ${src.note}`} /> : null;
      })}
    </div>
  );
}

function ReportState({ row }: { row: ReportAdminRow }) {
  if (row.report.generated) return <Badge state="ok" text={`v${row.report.latestVersion ?? row.report.versionCount}`} title={`生成于 ${fmtT(row.report.generatedAt)}`} />;
  if (row.report.cacheReady) return <Badge state="warn" text="缓存" title={`缓存于 ${fmtT(row.report.generatedAt)}`} />;
  return <Badge state="missing" text="未生成" />;
}

function MiniButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        border: "1px solid var(--line)",
        background: disabled ? "var(--inset)" : "var(--card)",
        color: disabled ? "var(--fg-3)" : "var(--fg)",
        borderRadius: 8,
        padding: "6px 9px",
        fontSize: 11,
        fontWeight: 800,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

export function ReportsView() {
  const [data, setData] = useState<ReportsPayload | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const load = async () => {
    setMsg("");
    const j = await fetch("/api/admin/reports", { cache: "no-store" }).then((r) => r.json()) as ReportsPayload;
    setData(j);
    if (!j.ok) setMsg(j.error || "读取失败");
  };

  useEffect(() => {
    void load();
  }, []);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = data?.rows ?? [];
    if (!s) return all;
    return all.filter((r) => `${r.fixtureId} ${r.match} ${r.league} ${r.round} ${r.statusText}`.toLowerCase().includes(s));
  }, [data?.rows, q]);

  const run = async (fixtureId: number, action: "refresh" | "regenerate") => {
    setBusy(`${action}:${fixtureId}`);
    setMsg("");
    try {
      const j = await fetch("/api/admin/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixtureId, action }),
      }).then((r) => r.json()) as { ok: boolean; error?: string; message?: string };
      setMsg(j.ok ? (j.message || "已刷新诊断") : (j.error || "操作失败"));
      await load();
    } finally {
      setBusy("");
    }
  };

  const summary = data?.summary ?? { total: 0, generated: 0, cacheReady: 0, missing: 0, locked: 0, needsInput: 0, failed: 0 };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 900 }}>分析报告管理</div>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>逐场核对报告版本、锁定状态、真实输入源与缺失原因</div>
        </div>
        <span style={{ flex: 1 }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索比赛 / 球队 / 联赛 / fixture id"
          style={{ width: 280, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px", color: "var(--fg)", outline: "none", fontSize: 12 }}
        />
        <ABtn label="刷新" kind="line" onClick={() => void load()} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
        <Stat k="范围内比赛" v={summary.total} />
        <Stat k="已生成版本" v={summary.generated} tone="green" />
        <Stat k="缓存可用" v={summary.cacheReady} tone="warn" />
        <Stat k="未生成" v={summary.missing} tone="red" />
        <Stat k="已锁定" v={summary.locked} />
        <Stat k="缺输入" v={summary.needsInput} tone="warn" />
        <Stat k="有失败诊断" v={summary.failed} tone="red" />
      </div>

      {msg && <div style={{ fontSize: 12, color: msg.includes("失败") || msg.includes("不能") ? "var(--red)" : "var(--fg-2)" }}>{msg}</div>}

      <ACard title="报告与输入源" pad={false}>
        <div style={{ display: "grid", gridTemplateColumns: "1.25fr .55fr 1.2fr 1.45fr 1.35fr .75fr", gap: 0, padding: "9px 14px", borderBottom: "1px solid var(--line)", color: "var(--fg-3)", fontSize: 11 }}>
          <span>比赛</span>
          <span>报告</span>
          <span>访问/锁定</span>
          <span>输入源</span>
          <span>缺失/失败</span>
          <span style={{ textAlign: "right" }}>操作</span>
        </div>
        {rows.map((row) => (
          <div
            key={row.fixtureId}
            style={{
              display: "grid",
              gridTemplateColumns: "1.25fr .55fr 1.2fr 1.45fr 1.35fr .75fr",
              gap: 12,
              alignItems: "center",
              padding: "13px 14px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 900, minWidth: 0 }}>
                <span className="mono" style={{ color: "var(--fg-3)", fontWeight: 700 }}>{row.fixtureId}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.match}</span>
                {row.score && <span className="mono" style={{ color: "var(--red)" }}>{row.score}</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.league} · {row.round || "—"} · {fmtT(row.kickoffUtc)} · {row.statusText}
              </div>
            </div>
            <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
              <ReportState row={row} />
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{row.report.model || row.report.algorithmVersion}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.7 }}>
              <div>{row.locked ? "开赛后锁定" : "可更新"}</div>
              <div>{row.access.free ? "免费场" : row.access.unlocks > 0 ? `已解锁 ${row.access.unlocks}` : "未解锁"}</div>
              <div>版本 {row.report.versionCount} · {fmtT(row.report.generatedAt)}</div>
            </div>
            <SourcePills sources={row.sources} />
            <div style={{ minWidth: 0 }}>
              {row.failureReason ? (
                <div style={{ color: "var(--red)", fontSize: 11, lineHeight: 1.5 }}>{row.failureReason}</div>
              ) : row.missingInputs.length > 0 ? (
                <div style={{ color: "var(--warn)", fontSize: 11, lineHeight: 1.5 }}>{row.missingInputs.slice(0, 3).join("；")}</div>
              ) : (
                <div style={{ color: "var(--fg-3)", fontSize: 11 }}>暂无阻塞项</div>
              )}
              {row.report.summary && <div style={{ color: "var(--fg-3)", fontSize: 10.5, marginTop: 5, lineHeight: 1.45 }}>{row.report.summary}</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <MiniButton label="重算诊断" disabled={!!busy} onClick={() => void run(row.fixtureId, "refresh")} />
              <MiniButton
                label={row.canRegenerate ? "重新生成" : "已锁定"}
                disabled={!!busy || !row.canRegenerate || busy === `regenerate:${row.fixtureId}`}
                onClick={() => void run(row.fixtureId, "regenerate")}
              />
            </div>
          </div>
        ))}
        {rows.length === 0 && <div style={{ padding: 30, textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>暂无匹配比赛</div>}
      </ACard>
    </div>
  );
}
