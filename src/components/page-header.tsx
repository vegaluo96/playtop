"use client";

/** 统一一级页头:单行紧凑 —— 模块名 + 极简动态信息(meta) + 右侧动作。
 *  设计取舍:底部导航已标注当前菜单,标题不必再大;范围/筛选/分页等信息与下方
 *  chips/tab 重复,一律不再在头部复述,头部只保留「不在别处出现」的关键数(场次/季等)。 */
import { useState, type ReactNode } from "react";
import { HeartBeat } from "./live";
import { RefreshSheet } from "./refresh-sheet";

export function PageHeader({
  title,
  meta,
  lastAt,
  workerAt,
  intervalMs = 10_000,
  right,
}: {
  title: ReactNode;
  /** 极简动态信息(如「12 场」「2025 赛季·官方」);与下方筛选器重复的范围词不要放这里 */
  meta?: ReactNode;
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
          {meta && (
            <span style={{ fontSize: 11.5, lineHeight: 1.2, color: "var(--fg-3)", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
              {meta}
            </span>
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
