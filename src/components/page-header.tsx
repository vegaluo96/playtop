"use client";

/**
 * 统一页头(四个一级菜单同构):左 = 页面标题;右固定两行 ——
 *   第一行:真实连接状态与延迟(已连接·Nms / 数据延迟 / 盯盘暂停,全部实测推导)
 *   第二行:「数据刷新规则」入口(弹层内嵌于本组件,各页零接线)
 */
import { useState, type ReactNode } from "react";
import { HeartBeat } from "./live";
import { RefreshSheet } from "./refresh-sheet";

export function PageHeader({
  title, lastAt, workerAt, intervalMs = 10_000, rtt,
}: {
  title: ReactNode;
  lastAt?: number | null;
  workerAt?: number | null;
  intervalMs?: number;
  rtt?: number | null;
}) {
  const [rfOpen, setRfOpen] = useState(false);
  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "14px 16px 10px", flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5 }}>{title}</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <HeartBeat lastAt={lastAt ?? null} intervalMs={intervalMs} workerAt={workerAt} rtt={rtt} />
          <div onClick={() => setRfOpen(true)} style={{ fontSize: 9, color: "var(--gold)", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
            ⟳ 数据刷新规则 ›
          </div>
        </div>
      </div>
      <RefreshSheet open={rfOpen} onClose={() => setRfOpen(false)} activeIdx={null} />
    </>
  );
}
