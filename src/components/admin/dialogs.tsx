"use client";

/**
 * 后台对话框套件(替代原生 prompt/alert/confirm,Promise 风格):
 *   aPrompt(标题, 默认值?, 说明?) → string | null
 *   aConfirm(文案) → boolean(自动附「写入审计」提示)
 *   aAlert(文案) → void
 * AdminDialogHost 挂载在后台根组件,一次挂载全局可用。
 */
import { useEffect, useState, type ReactNode } from "react";

type Dialog =
  | { kind: "prompt"; title: string; def?: string; hint?: string; multiline?: boolean; resolve: (v: string | null) => void }
  | { kind: "confirm"; text: string; resolve: (v: boolean) => void }
  | { kind: "alert"; text: string; resolve: () => void };

let push: ((d: Dialog) => void) | null = null;

export function aPrompt(title: string, def = "", hint?: string, multiline = false): Promise<string | null> {
  return new Promise((resolve) => {
    if (!push) return resolve(window.prompt(title, def)); // Host 未挂载时兜底
    push({ kind: "prompt", title, def, hint, multiline, resolve });
  });
}
export function aConfirm(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) return resolve(window.confirm(text));
    push({ kind: "confirm", text, resolve });
  });
}
export function aAlert(text: string | undefined | null): Promise<void> {
  return new Promise((resolve) => {
    if (!push) {
      window.alert(String(text ?? "操作失败"));
      return resolve();
    }
    push({ kind: "alert", text: String(text ?? "操作失败"), resolve });
  });
}

export function AdminDialogHost() {
  const [d, setD] = useState<Dialog | null>(null);
  const [val, setVal] = useState("");
  useEffect(() => {
    push = (next) => {
      setD(next);
      setVal(next.kind === "prompt" ? (next.def ?? "") : "");
    };
    return () => {
      push = null;
    };
  }, []);
  if (!d) return null;

  const close = (commit: boolean) => {
    if (d.kind === "prompt") d.resolve(commit ? val : null);
    else if (d.kind === "confirm") d.resolve(commit);
    else d.resolve();
    setD(null);
  };

  const Btn = ({ label, gold, onClick }: { label: string; gold?: boolean; onClick: () => void }) => (
    <span
      onClick={onClick}
      style={{
        flex: 1, textAlign: "center", cursor: "pointer", borderRadius: 9, padding: "10px 0", fontSize: 12.5, fontWeight: 800,
        background: gold ? "linear-gradient(90deg,var(--gold),var(--gold-2))" : "var(--inset)",
        color: gold ? "#0a0b0f" : "var(--fg-2)",
        border: gold ? "none" : "1px solid var(--line)",
      }}
    >
      {label}
    </span>
  );
  const body: ReactNode =
    d.kind === "prompt" ? (
      <>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: d.hint ? 4 : 12 }}>{d.title}</div>
        {d.hint && <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginBottom: 10, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{d.hint}</div>}
        {d.multiline ? (
          <textarea
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            rows={5}
            style={{ width: "100%", boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px", fontSize: 12, color: "var(--fg)", outline: "none", resize: "vertical", marginBottom: 14 }}
          />
        ) : (
          <input
            autoFocus
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && close(true)}
            style={{ width: "100%", boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px", fontSize: 12.5, color: "var(--fg)", outline: "none", marginBottom: 14 }}
          />
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <Btn label="取消" onClick={() => close(false)} />
          <Btn label="确认" gold onClick={() => close(true)} />
        </div>
      </>
    ) : d.kind === "confirm" ? (
      <>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.7, marginBottom: 6, whiteSpace: "pre-wrap" }}>{d.text}</div>
        <div style={{ fontSize: 10, color: "var(--fg-3)", marginBottom: 14 }}>该操作将写入审计日志,确认执行?</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn label="取消" onClick={() => close(false)} />
          <Btn label="确认执行" gold onClick={() => close(true)} />
        </div>
      </>
    ) : (
      <>
        <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.7, marginBottom: 14, whiteSpace: "pre-wrap" }}>{d.text}</div>
        <Btn label="知道了" gold onClick={() => close(true)} />
      </>
    );

  return (
    <div
      onClick={() => close(false)}
      style={{ position: "fixed", inset: 0, zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(4,5,9,.7)" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "calc(100vw - 48px)", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: "18px 18px 16px", display: d.kind === "alert" ? "flex" : "block", flexDirection: "column" }}>
        {body}
      </div>
    </div>
  );
}
