"use client";

/** 统一一级页头:单行紧凑 —— 模块名 + 右侧动作。无副标题。
 *  设计取舍:底部导航已标注当前菜单,范围/筛选/分页等信息与下方 chips/tab 重复,
 *  一律不在头部复述。 */
import { useState, type ReactNode } from "react";
import { HeartBeat } from "./live";
import { RefreshSheet } from "./refresh-sheet";

export function PageHeader({
  title,
  lastAt,
  workerAt,
  intervalMs = 10_000,
  right,
}: {
  title: ReactNode;
  lastAt?: number | null;
  workerAt?: number | null;
  intervalMs?: number;
  rtt?: number | null;
  right?: ReactNode;
}) {
  const [rfOpen, setRfOpen] = useState(false);
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px 6px", flexShrink: 0, minHeight: 38, boxSizing: "border-box" }}>
        <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 17, lineHeight: 1.1, fontWeight: 900, whiteSpace: "nowrap", flexShrink: 0 }}>{title}</span>
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
