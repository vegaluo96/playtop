"use client";

/** 桌面居中弹窗(点遮罩关闭;内容区阻止冒泡) */
import type { ReactNode } from "react";

export function Modal({ open, onClose, width = 460, children }: { open: boolean; onClose: () => void; width?: number; children: ReactNode }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: "absolute", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--overlay)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width, maxWidth: "92vw", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", maxHeight: "78vh", boxShadow: "var(--surface-shadow)" }}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ flexShrink: 0, display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
      <span style={{ fontSize: 15, fontWeight: 800 }}>{title}</span>
      {hint && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{hint}</span>}
    </div>
  );
}
