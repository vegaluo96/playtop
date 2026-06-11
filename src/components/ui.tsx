"use client";

/** 统一 UI 原语(设计稿:弹层=底部 sheet+拖把手+遮罩关闭;二级页=‹ 返回+居中标题) */

import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

export function Sheet({ open, onClose, children, z = 65 }: { open: boolean; onClose: () => void; children: ReactNode; z?: number }) {
  if (!open) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: z, display: "flex", flexDirection: "column", justifyContent: "flex-end", background: "rgba(4,5,9,.72)" }}>
      <div onClick={onClose} style={{ flex: 1 }} />
      <div style={{ background: "#14161d", borderTop: "1px solid #262a34", borderRadius: "18px 18px 0 0", padding: "10px 16px 24px" }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "#262a34", margin: "0 auto 14px" }} />
        {children}
      </div>
    </div>
  );
}

export function SheetTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
      <span style={{ fontSize: 15, fontWeight: 800 }}>{title}</span>
      {hint && <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{hint}</span>}
    </div>
  );
}

export function Chip({ label, active, onClick, style }: { label: string; active: boolean; onClick: () => void; style?: CSSProperties }) {
  return (
    <div
      onClick={onClick}
      style={{
        flexShrink: 0,
        padding: "6px 13px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        background: active ? "rgba(233,185,73,.14)" : "var(--card)",
        color: active ? "var(--gold)" : "var(--fg-2)",
        border: `1px solid ${active ? "rgba(233,185,73,.45)" : "var(--line)"}`,
        ...style,
      }}
    >
      {label}
    </div>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "16px 4px 8px" }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 9, color: "var(--fg-4)" }} className="mono">{right}</div>
    </div>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, ...style }}>{children}</div>;
}

export function GoldBtn({ label, onClick, style }: { label: string; onClick: () => void; style?: CSSProperties }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "linear-gradient(90deg,var(--gold),var(--gold-2))",
        color: "#0a0b0f",
        borderRadius: 10,
        textAlign: "center",
        padding: "12px 0",
        fontSize: 13.5,
        fontWeight: 800,
        cursor: "pointer",
        ...style,
      }}
    >
      {label}
    </div>
  );
}

/** 二级页头:‹ 返回 + 居中标题(+ 可选右侧动作) */
export function SubpageHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  const router = useRouter();
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 6px" }}>
      <div
        onClick={onBack ?? (() => router.back())}
        style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--fg-2)", fontSize: 22, lineHeight: 1 }}
      >
        ‹
      </div>
      <div style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: 800 }}>{title}</div>
      <div style={{ width: 34, display: "flex", alignItems: "center", justifyContent: "center" }}>{right}</div>
    </div>
  );
}

export function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="10" r="2.4" />
      <circle cx="15" cy="4.5" r="2.4" />
      <circle cx="15" cy="15.5" r="2.4" />
      <path d="M7.2 8.9l5.6-3.2M7.2 11.1l5.6 3.2" />
    </svg>
  );
}

export function LockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="var(--gold)" strokeWidth="1.6" strokeLinecap="round">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function EmptyBox({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ background: "var(--card)", border: "1px dashed #272d3a", borderRadius: 12, padding: "32px 20px", textAlign: "center", marginTop: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-2)" }}>{title}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.7 }}>{sub}</div>}
    </div>
  );
}
