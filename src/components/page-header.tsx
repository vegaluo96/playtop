"use client";

/**
 * 统一页头(四个一级菜单同构):左 = 页面标题;右 = 可替换动作。
 * 默认右侧为连接状态;传入 right 后由页面自定义(如搜索入口)。
 */
import { useState, type ReactNode } from "react";
import { HeartBeat } from "./live";
import { RefreshSheet } from "./refresh-sheet";

export function PageHeader({
  title, lastAt, workerAt, intervalMs = 10_000, right,
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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "15px 16px 10px", flexShrink: 0 }}>
        <div style={{ fontSize: 19, fontWeight: 850, letterSpacing: 0 }}>{title}</div>
        {right ?? (
          <div onClick={() => setRfOpen(true)} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", cursor: "pointer", minHeight: 24, paddingTop: 2 }}>
            <HeartBeat lastAt={lastAt ?? null} intervalMs={intervalMs} workerAt={workerAt} />
          </div>
        )}
      </div>
      <RefreshSheet open={rfOpen} onClose={() => setRfOpen(false)} activeIdx={null} />
    </>
  );
}
