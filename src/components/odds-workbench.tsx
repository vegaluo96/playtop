"use client";

/** 指数工作台:书商初始/即时对照 + 最新走势摘要。只展示平台整理后的标准盘口。 */
import type { CSSProperties, ReactNode } from "react";
import { IndexChart } from "@/components/index-chart";
import { MarketValue } from "@/components/market-cell";
import { EmptyBox } from "@/components/ui";
import { ahText } from "@/lib/format";
import type { ChartRow } from "@/components/charts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export type OddsMarketKey = "ah" | "eu" | "ou" | "road";

export const ODDS_MARKET_TABS: { key: OddsMarketKey; label: string }[] = [
  { key: "ah", label: "让球" },
  { key: "ou", label: "大小" },
  { key: "eu", label: "胜平负" },
  { key: "road", label: "更多" },
];

const marketName: Record<Exclude<OddsMarketKey, "road">, string> = {
  ah: "让球",
  eu: "胜平负",
  ou: "大小",
};

function splitQuote(raw: unknown, size: number): string[] {
  const parts = String(raw ?? "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
  return Array.from({ length: size }, (_, i) => parts[i] ?? "—");
}

function num(v: unknown) {
  const n = Number.parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function quoteColor(now: unknown, initial: unknown) {
  const a = num(now);
  const b = num(initial);
  if (a == null || b == null || Math.abs(a - b) < 0.005) return "var(--fg)";
  return a > b ? "var(--red)" : "var(--green)";
}

function panelStyle(dense = false): CSSProperties {
  return {
    border: "1px solid var(--line)",
    borderRadius: dense ? 9 : 12,
    overflow: "hidden",
    background: "var(--card)",
  };
}

function Cell({ children, muted, color, style }: { children: ReactNode; muted?: boolean; color?: string; style?: CSSProperties }) {
  return (
    <span
      className="mono"
      style={{
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "center",
        fontSize: 12.5,
        fontWeight: 760,
        color: color ?? (muted ? "var(--fg-3)" : "var(--fg)"),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function OddsSegmentedTabs({ value, onChange }: { value: OddsMarketKey; onChange: (v: OddsMarketKey) => void }) {
  return (
    <div style={{ padding: "0 12px 10px", flexShrink: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: "1px solid var(--line)", borderRadius: 999, overflow: "hidden", background: "var(--card)" }}>
        {ODDS_MARKET_TABS.map((t) => {
          const active = value === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              style={{
                height: 34,
                border: 0,
                borderRight: t.key === "road" ? 0 : "1px solid var(--line)",
                borderRadius: active ? 999 : 0,
                background: active ? "var(--gold)" : "transparent",
                color: active ? "var(--on-accent)" : "var(--fg)",
                fontSize: 13,
                fontWeight: 850,
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DesktopOddsSegmentedTabs({ value, onChange }: { value: OddsMarketKey; onChange: (v: OddsMarketKey) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, border: "1px solid var(--line)", borderRadius: 999, overflow: "hidden", background: "var(--card)" }}>
      {ODDS_MARKET_TABS.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            style={{
              minWidth: 74,
              height: 28,
              border: 0,
              borderRight: t.key === "road" ? 0 : "1px solid var(--line)",
              borderRadius: active ? 999 : 0,
              background: active ? "var(--gold)" : "transparent",
              color: active ? "var(--on-accent)" : "var(--fg-2)",
              fontSize: 12,
              fontWeight: 850,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function OddsCompareMatrix({
  market,
  rows,
  meta,
  compact = false,
  finished = false,
  onHistory,
}: {
  market: "ah" | "ou" | "eu";
  rows: V[];
  /** 市场分歧/离散度(三盘统一结构 { books, dispText, method }) */
  meta?: V | null;
  compact?: boolean;
  finished?: boolean;
  onHistory: (row: V) => void;
}) {
  const isEu = market === "eu";
  const safeRows = Array.isArray(rows) ? rows : [];
  const labels = market === "ah" ? ["主", "让球", "客"] : market === "ou" ? ["大", "总进球", "小"] : ["主胜", "平局", "客胜"];
  const grid = compact ? "72px repeat(6,minmax(34px,1fr)) 12px" : "82px repeat(6,minmax(44px,1fr)) 14px";

  return (
    <div style={panelStyle(compact)}>
      <div style={{ display: "grid", gridTemplateColumns: grid, background: "var(--inset)", borderBottom: "1px solid var(--line)" }}>
        <Cell muted style={{ gridRow: "1 / 3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: compact ? 11 : 12, fontWeight: 850 }}>书商</Cell>
        <Cell muted style={{ gridColumn: "2 / 5", padding: "7px 0 2px", fontSize: compact ? 11 : 12, fontWeight: 850 }}>初始</Cell>
        <Cell muted style={{ gridColumn: "5 / 8", padding: "7px 0 2px", fontSize: compact ? 11 : 12, fontWeight: 850 }}>{finished ? "终盘" : "即时"}</Cell>
        <span />
        {[...labels, ...labels].map((l, i) => (
          <Cell key={`${l}-${i}`} muted style={{ padding: "0 0 7px", fontSize: compact ? 10.5 : 11, fontWeight: 800 }}>{l}</Cell>
        ))}
      </div>
      {safeRows.length === 0 && <EmptyBox title={`${marketName[market]}暂无指数数据`} sub={finished ? "本场未归档完整指数数据" : "开盘后将按真实快照自动展示"} />}
      {safeRows.map((row: V, idx: number) => {
        const iW = splitQuote(row.iW, isEu ? 3 : 2);
        const nW = splitQuote(row.nW, isEu ? 3 : 2);
        const initCells = isEu ? iW : [iW[0], row.iText ?? "—", iW[1]];
        const nowCells = isEu ? nW : [nW[0], row.nText ?? "—", nW[1]];
        return (
          <div
            key={`${row.co}-${idx}`}
            onClick={() => row.bid && onHistory(row)}
            style={{
              display: "grid",
              gridTemplateColumns: grid,
              alignItems: "center",
              minHeight: compact ? 50 : 58,
              background: row.live ? "var(--danger-bg-soft)" : idx % 2 ? "var(--inset)" : "var(--card)",
              borderBottom: "1px solid var(--line-soft)",
              cursor: row.bid ? "pointer" : "default",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", minWidth: 0, height: "100%", padding: compact ? "0 8px" : "0 10px", background: row.live ? "var(--danger-bg-soft)" : "var(--selected-bg-soft)", borderRight: "1px solid var(--line-soft)" }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: compact ? 11.5 : 12.5, fontWeight: 800 }}>{row.co}</span>
            </span>
            {initCells.map((v, i) => (
              <Cell key={`i-${i}`} muted={String(v) === "—"}>{v}</Cell>
            ))}
            {nowCells.map((v, i) => {
              const ref = initCells[i];
              const color = !isEu && i === 1 ? (row.changed ? "var(--red)" : "var(--fg)") : quoteColor(v, ref);
              return <Cell key={`n-${i}`} muted={String(v) === "—"} color={color}>{v}</Cell>;
            })}
            <Cell muted style={{ fontSize: 18, fontWeight: 500 }}>›</Cell>
          </div>
        );
      })}
      {meta && (
        <div style={{ padding: compact ? "8px 10px" : "9px 12px", borderTop: "1px solid var(--line)", color: "var(--fg-3)", fontSize: compact ? 10.5 : 11.5, lineHeight: 1.5 }}>
          市场分歧 {meta.dispText} · {meta.books} 家 · {meta.method}
        </div>
      )}
    </div>
  );
}

export function OddsTrendPanel({
  market,
  title,
  data,
  index,
  kickoff,
  tz,
  compact = false,
  onHistory,
}: {
  market: "ah" | "ou";
  title: string;
  data?: { rows?: V[]; chart?: ChartRow[] } | null;
  index?: V;
  kickoff: number;
  tz: string;
  compact?: boolean;
  onHistory: () => void;
}) {
  const cols = market === "ah" ? ["时间", "指数", "主水", "客水"] : ["时间", "指数", "大水", "小水"];
  const safeRows = Array.isArray(data?.rows) ? data.rows : [];
  return (
    <div style={{ marginTop: compact ? 10 : 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "0 2px 8px" }}>
        <span style={{ fontSize: compact ? 12 : 13, fontWeight: 850 }}>{title}</span>
        <span style={{ fontSize: compact ? 10.5 : 11.5, color: "var(--fg-3)" }}>最新 3 条</span>
      </div>
      <div style={panelStyle(compact)}>
        <div style={{ padding: compact ? "8px 8px 6px" : "10px 10px 8px", borderBottom: "1px solid var(--line)" }}>
          <IndexChart
            data={index}
            kickoff={kickoff}
            tz={tz}
            unit={market === "ah" ? "主水指数" : "大球指数"}
            lineText={(l) => (l == null ? "" : market === "ah" ? ahText(l) : `${l} 球`)}
            height={compact ? 134 : 178}
          />
          {!compact && <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 5, lineHeight: 1.5 }}>{index?.method}</div>}
        </div>
        <QuoteRows cols={cols} rows={safeRows} eu={false} compact={compact} onHistory={onHistory} />
      </div>
    </div>
  );
}

export function OddsEuTrendPanel({
  rows,
  index,
  kickoff,
  tz,
  compact = false,
  onHistory,
}: {
  rows?: V[] | null;
  index?: V;
  kickoff: number;
  tz: string;
  compact?: boolean;
  onHistory: () => void;
}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return (
    <div style={{ marginTop: compact ? 10 : 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "0 2px 8px" }}>
        <span style={{ fontSize: compact ? 12 : 13, fontWeight: 850 }}>胜平负走势</span>
        <span style={{ fontSize: compact ? 10.5 : 11.5, color: "var(--fg-3)" }}>最新 3 条</span>
      </div>
      <div style={panelStyle(compact)}>
        <div style={{ padding: compact ? "8px 8px 6px" : "10px 10px 8px", borderBottom: "1px solid var(--line)" }}>
          <IndexChart data={index} kickoff={kickoff} tz={tz} unit="主胜概率" height={compact ? 134 : 178} />
          {!compact && <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 5, lineHeight: 1.5 }}>{index?.method}</div>}
        </div>
        <QuoteRows cols={["时间", "主胜", "平局", "客胜"]} rows={safeRows} eu compact={compact} onHistory={onHistory} />
      </div>
    </div>
  );
}

function QuoteRows({
  cols,
  rows,
  eu,
  compact,
  onHistory,
}: {
  cols: string[];
  rows?: V[] | null;
  eu: boolean;
  compact: boolean;
  onHistory: () => void;
}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const grid = compact ? "62px repeat(3,minmax(42px,1fr))" : "76px repeat(3,minmax(50px,1fr))";
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: grid, padding: compact ? "7px 9px" : "8px 12px", borderBottom: "1px solid var(--line)", columnGap: 8 }}>
        {cols.map((c, i) => <Cell key={c} muted style={{ textAlign: i === 0 ? "left" : "right", fontSize: compact ? 10.5 : 11 }}>{c}</Cell>)}
      </div>
      {safeRows.length === 0 && <div style={{ padding: 14, fontSize: 12, color: "var(--fg-3)", textAlign: "center" }}>快照积累中</div>}
      {safeRows.map((r: V, i: number) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: grid, columnGap: 8, padding: compact ? "7px 9px" : "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
          <Cell muted style={{ textAlign: "left", fontSize: compact ? 10.5 : 11 }}>{r.t}</Cell>
          {eu ? (
            <>
              <MarketValue v={r.h} small style={{ justifyContent: "flex-end" }} />
              <MarketValue v={r.d} small dim style={{ justifyContent: "flex-end" }} />
              <MarketValue v={r.a} small style={{ justifyContent: "flex-end" }} />
            </>
          ) : (
            <>
              <Cell color={r.chg ? "var(--red)" : "var(--fg)"} style={{ textAlign: "right", fontWeight: 850 }}>{r.text}</Cell>
              <MarketValue v={r.h} small style={{ justifyContent: "flex-end" }} />
              <MarketValue v={r.a} small style={{ justifyContent: "flex-end" }} />
            </>
          )}
        </div>
      ))}
      <div onClick={onHistory} style={{ padding: compact ? "9px 0" : "10px 0", textAlign: "center", fontSize: compact ? 11.5 : 12, fontWeight: 850, color: "var(--gold)", cursor: "pointer" }}>
        完整历史报价 ›
      </div>
    </>
  );
}
