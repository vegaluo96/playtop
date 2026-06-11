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
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)", margin: "6px 0 26px" }}>亚盘 · 大小球 · 胜平负 · 专业数据</div>
      <div style={{ background: "rgba(233,185,73,.1)", border: "1px dashed rgba(233,185,73,.45)", borderRadius: 10, padding: "10px 12px", marginBottom: 18, display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 8, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#0a0b0f" }}>礼</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-mid)", lineHeight: 1.55 }}>
          注册后全站盘口与异动<span style={{ color: "var(--up)", fontWeight: 800 }}>免费</span>查看;再送{" "}
          <span style={{ color: "var(--gold)", fontWeight: 800 }}>58 积分</span>,可解锁 1 场官方预测
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
      {err && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 10 }}>{err}</div>}
      <GoldBtn label={busy ? "处理中…" : "登录 / 注册"} onClick={submit} style={{ padding: "13px 0", fontSize: 15 }} />
      <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)", marginTop: 10 }}>未注册的邮箱将自动创建账户,无需邮箱验证</div>
      <div
        onClick={() => router.push("/")}
        style={{ textAlign: "center", fontSize: 12, color: "var(--fg-3)", marginTop: 22, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
      >
        暂不注册,返回浏览 ›
      </div>
    </div>
  );
}
