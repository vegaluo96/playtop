"use client";

/** 后台 UI 原语(对照管理后台稿的卡/表/chip/按钮) */
import type { CSSProperties, ReactNode } from "react";

export const fmtT = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function ACard({ title, right, children, style, pad = true }: { title?: ReactNode; right?: ReactNode; children: ReactNode; style?: CSSProperties; pad?: boolean }) {
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", ...style }}>
      {title != null && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ fontSize: 12, fontWeight: 800 }}>{title}</span>
          {right}
        </div>
      )}
      <div style={pad ? { padding: "13px 14px" } : undefined}>{children}</div>
    </div>
  );
}

export function AGrid({ cols, children, head }: { cols: string; children: ReactNode; head?: boolean }) {
  return (
    <div
      style={{
        display: "grid", gridTemplateColumns: cols, padding: head ? "9px 14px" : "9px 14px", alignItems: "center",
        borderBottom: head ? "1px solid var(--line)" : "1px solid var(--line-soft)",
      }}
    >
      {children}
    </div>
  );
}

export const Th = ({ t, right, center }: { t: string; right?: boolean; center?: boolean }) => (
  <span style={{ fontSize: 11, color: "var(--fg-3)", textAlign: right ? "right" : center ? "center" : "left" }}>{t}</span>
);

export function AChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "5px 12px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
        background: active ? "rgba(0,200,5,.14)" : "var(--card)",
        color: active ? "var(--gold)" : "var(--fg-2)",
        border: `1px solid ${active ? "rgba(0,200,5,.45)" : "var(--line)"}`,
      }}
    >
      {label}
    </div>
  );
}

export function ABtn({ label, onClick, kind = "gold", small }: { label: string; onClick: () => void; kind?: "gold" | "line" | "red" | "blue" | "green"; small?: boolean }) {
  const styles: Record<string, CSSProperties> = {
    gold: { background: "var(--gold)", color: "var(--on-accent)" },
    line: { border: "1px solid rgba(0,200,5,.5)", color: "var(--gold)" },
    red: { color: "var(--red)" },
    blue: { color: "var(--home)" },
    green: { color: "var(--green)" },
  };
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-block", borderRadius: small ? 6 : 9, textAlign: "center", cursor: "pointer", fontWeight: 800,
        fontSize: small ? 11 : 12.5, padding: small ? "0" : "9px 14px", ...styles[kind],
      }}
    >
      {label}
    </span>
  );
}

export function AInput({ id, placeholder, width, mono, defaultValue }: { id: string; placeholder?: string; width?: number | string; mono?: boolean; defaultValue?: string }) {
  return (
    <input
      id={id}
      placeholder={placeholder}
      defaultValue={defaultValue}
      className={mono ? "mono" : undefined}
      style={{ width: width ?? "100%", minWidth: 0, boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "var(--fg)", outline: "none" }}
    />
  );
}

export const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";

export async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

