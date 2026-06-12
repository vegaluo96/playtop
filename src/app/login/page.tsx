"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { GoldBtn } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { refreshMe } = useApp();

  const submit = async () => {
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error || "登录失败");
        return;
      }
      await refreshMe();
      router.push("/me");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    background: "var(--card)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: "13px 14px",
    fontSize: 14,
    color: "var(--fg)",
    outline: "none",
    marginBottom: 10,
    width: "100%",
  } as const;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 28px 30px", minHeight: 0, width: "100%", maxWidth: 456, margin: "0 auto", height: "100%" }}>
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 1, textAlign: "center" }}>
        足球<span style={{ color: "var(--gold)" }}>终端</span>
      </div>
      <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--fg-3)", margin: "6px 0 26px" }}>让球指数 · 大小指数 · 胜平负指数 · 专业行情终端</div>
      <div style={{ background: "rgba(0,200,5,.1)", border: "1px dashed rgba(0,200,5,.45)", borderRadius: 10, padding: "10px 12px", marginBottom: 18, display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "var(--on-accent)" }}>AI</span>
        <span style={{ fontSize: 12.5, color: "var(--fg-mid)", lineHeight: 1.55 }}>
          登录后查看完整指数与异动流 · 新账号含基础报告额度
        </span>
      </div>
      <input type="email" placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
      <input
        type="password"
        placeholder="密码(至少 6 位)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        style={{ ...inputStyle, marginBottom: 14 }}
      />
      {err && <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 10 }}>{err}</div>}
      <GoldBtn label={busy ? "处理中…" : "登录 / 注册"} onClick={submit} style={{ padding: "13px 0", fontSize: 15 }} />
      <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)", marginTop: 10 }}>未注册的邮箱将自动创建账户,无需邮箱验证</div>
      <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.6 }}>
        登录/注册即同意<a href="/about" style={{ color: "var(--fg-3)" }}>《平台性质与免责声明》</a> · 仅提供数据资讯
      </div>
      <div
        onClick={() => router.push("/")}
        style={{ textAlign: "center", fontSize: 12, color: "var(--fg-3)", marginTop: 22, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
      >
        暂不注册,返回浏览 ›
      </div>
    </div>
  );
}
