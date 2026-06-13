"use client";

/** 统一一级页头:模块标题 + 当前范围 + 右侧动作。 */
import { useState, type ReactNode } from "react";
import { HeartBeat } from "./live";
import { RefreshSheet } from "./refresh-sheet";

export function PageHeader({
  title,
  subtitle,
  kicker,
  lastAt,
  workerAt,
  intervalMs = 10_000,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  kicker?: ReactNode;
  lastAt?: number | null;
  workerAt?: number | null;
  intervalMs?: number;
  rtt?: number | null;
  right?: ReactNode;
}) {
  const [rfOpen, setRfOpen] = useState(false);
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px 10px", flexShrink: 0, minHeight: 54, boxSizing: "border-box" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          {kicker && (
            <div style={{ fontSize: 10.5, color: "var(--fg-3)", fontWeight: 800, letterSpacing: 0, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {kicker}
            </div>
          )}
          <div style={{ fontSize: 21, lineHeight: 1.08, fontWeight: 900, letterSpacing: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          {subtitle && (
            <div style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.2, color: "var(--fg-3)", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {subtitle}
            </div>
          )}
        </div>
        {right ?? (
          <div onClick={() => setRfOpen(true)} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", cursor: "pointer", minHeight: 34, flexShrink: 0 }}>
            <HeartBeat lastAt={lastAt ?? null} intervalMs={intervalMs} workerAt={workerAt} />
          </div>
        )}
      </div>
      <RefreshSheet open={rfOpen} onClose={() => setRfOpen(false)} activeIdx={null} />
    </>
  );
}
