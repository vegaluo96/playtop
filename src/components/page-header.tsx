"use client";

/** 统一页头(全部移动端一级页同构):左=页面标题;右=日期·时区 + 盯盘心跳(+可选附加行) */
import type { ReactNode } from "react";
import { useApp } from "./app-context";
import { HeartBeat } from "./live";
import { mdLabel } from "@/lib/format";

export function PageHeader({
  title, lastAt, workerAt, intervalMs = 10_000, right,
}: {
  title: ReactNode;
  lastAt?: number | null;
  workerAt?: number | null;
  intervalMs?: number;
  right?: ReactNode;
}) {
  const { prefs } = useApp();
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "14px 16px 10px", flexShrink: 0 }}>
      <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <div className="mono" style={{ fontSize: 9, color: "var(--fg-3)", whiteSpace: "nowrap" }}>
          {mdLabel(Date.now(), prefs.tz)} · {prefs.tz}
        </div>
        {lastAt !== undefined && <HeartBeat lastAt={lastAt ?? null} intervalMs={intervalMs} workerAt={workerAt} />}
        {right}
      </div>
    </div>
  );
}
