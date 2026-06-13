"use client";

/**
 * 数据契约 §5/§6 的前端消费原语(可复用,UI 重构沿用):
 *  - <SourceBadge>:按 DirectionSignal.sourceKind/derived 显著区分"模型预测 vs 指数派生(行情观察)",
 *    绝不让盘口派生看起来像模型预测(红线)。
 *  - <CoverageStrip>:按 publicSourceCoverage 展示各源 used/missing/failed/stale 与安全原因,
 *    让"为什么没有"对用户可见(取代静默 0%/空白)。
 * 仅消费 /api 视图模型字段,不读任何 AF raw(F1)。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type SourceKind = "prediction" | "marketDerived" | "marketOnly" | "model" | "mixed" | "open";

const KIND_BADGE: Record<SourceKind, { label: string; bg: string; fg: string } | null> = {
  prediction: { label: "模型预测", bg: "var(--success-bg)", fg: "var(--green)" },
  model: { label: "量化模型", bg: "var(--info-bg)", fg: "var(--home)" },
  mixed: { label: "多源加权", bg: "var(--info-bg)", fg: "var(--home)" },
  marketDerived: { label: "指数派生 · 行情观察", bg: "var(--selected-bg)", fg: "var(--gold)" },
  marketOnly: { label: "市场信号", bg: "var(--selected-bg)", fg: "var(--gold)" },
  open: null,
};

/** 方向来源徽标:派生信号显著标注,绝不冒充模型预测 */
export function SourceBadge({ signal, style }: { signal: { sourceKind?: SourceKind; derived?: boolean } | null | undefined; style?: React.CSSProperties }) {
  if (!signal) return null;
  const kind: SourceKind = signal.derived ? "marketDerived" : (signal.sourceKind ?? "open");
  const b = KIND_BADGE[kind];
  if (!b) return null;
  return (
    <span style={{ display: "inline-block", fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "1px 6px", background: b.bg, color: b.fg, whiteSpace: "nowrap", ...style }}>
      {b.label}
    </span>
  );
}

const STATUS_DOT: Record<string, string> = {
  used: "var(--green)",
  missing: "var(--fg-4)",
  failed: "var(--red)",
  stale: "var(--gold)",
  pendingReview: "var(--gold)",
};

/** 源覆盖条:展示未就绪源的安全原因(used 折叠为"N/M 就绪") */
export function CoverageStrip({ coverage, style }: { coverage: Record<string, any> | null | undefined; style?: React.CSSProperties }) {
  if (!coverage) return null;
  const items = Object.values(coverage) as { label: string; status: string; statusText: string; reason: string; usedInReport: boolean }[];
  if (items.length === 0) return null;
  const used = items.filter((i) => i.status === "used").length;
  const issues = items.filter((i) => i.status !== "used");
  return (
    <div style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 10px", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: issues.length ? 6 : 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: "var(--fg-2)" }}>数据源覆盖</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{used}/{items.length} 就绪</span>
      </div>
      {issues.map((i) => (
        <div key={i.label} style={{ display: "flex", alignItems: "baseline", gap: 7, padding: "2px 0" }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: STATUS_DOT[i.status] ?? "var(--fg-4)", flexShrink: 0, transform: "translateY(-1px)" }} />
          <span style={{ fontSize: 11, color: "var(--fg-2)", flexShrink: 0, minWidth: 56 }}>{i.label}</span>
          <span style={{ fontSize: 10.5, color: "var(--fg-3)", lineHeight: 1.5 }}>{i.reason || i.statusText}</span>
        </div>
      ))}
    </div>
  );
}
