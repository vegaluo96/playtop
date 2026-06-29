import { useState, type CSSProperties } from "react";
import { login } from "./logic/auth";

// 后台登录页（新增页面，原型未含；风格对齐 Admin：浅底、#6E5CFF 主色、圆角卡片）。
export function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    if (!password.trim()) {
      setError("请输入密码");
      return;
    }
    setBusy(true);
    setError("");
    const res = await login(username.trim(), password);
    setBusy(false);
    if (res.ok) onSuccess();
    else setError(res.error || "登录失败");
  }

  return (
    <div style={S.page}>
      <div style={S.card}>
        <div style={S.brand}>
          载思
          <span style={S.brandTag}>管理后台</span>
        </div>

        <label style={S.label}>账号</label>
        <input
          style={S.input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="账号"
          autoComplete="username"
        />

        <label style={S.label}>密码</label>
        <input
          style={S.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="密码"
          autoComplete="current-password"
        />

        {error ? <div style={S.error}>{error}</div> : null}

        <button style={{ ...S.button, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </div>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(160deg,#F4F3FF 0%,#F2F2F5 60%,#EFF3FB 100%)",
    fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif",
    padding: 24,
    boxSizing: "border-box",
  },
  card: {
    width: 360,
    maxWidth: "100%",
    background: "#fff",
    borderRadius: 20,
    boxShadow: "0 24px 60px rgba(20,16,40,.14),inset 0 0 0 1px rgba(0,0,0,.04)",
    padding: "30px 26px 26px",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
  },
  brand: { fontSize: 24, fontWeight: 700, letterSpacing: "-.3px", color: "#16161A", display: "flex", alignItems: "baseline", justifyContent: "center", gap: 2, marginBottom: 22 },
  brandTag: { fontSize: 12, fontWeight: 600, color: "#6E5CFF", background: "rgba(110,92,255,.1)", borderRadius: 8, padding: "2px 8px", marginLeft: 6 },
  label: { fontSize: 12, fontWeight: 600, color: "#5A5E6B", margin: "10px 2px 6px" },
  input: {
    boxSizing: "border-box",
    width: "100%",
    border: "1px solid #E6E7EB",
    outline: "none",
    background: "#FAFAFB",
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 15,
    color: "#16161A",
    fontFamily: "inherit",
  },
  error: { fontSize: 13, color: "#E0594F", background: "rgba(224,89,79,.08)", borderRadius: 10, padding: "9px 12px", marginTop: 12 },
  button: {
    marginTop: 18,
    border: "none",
    cursor: "pointer",
    background: "#6E5CFF",
    color: "#fff",
    fontSize: 15,
    fontWeight: 600,
    borderRadius: 13,
    padding: "13px 0",
    fontFamily: "inherit",
    boxShadow: "0 8px 20px rgba(110,92,255,.3)",
  },
};
