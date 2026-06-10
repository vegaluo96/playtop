"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      router.push("/");
      router.refresh();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-10 p-6">
      <h1 className="font-display text-center text-lg tracking-wider text-gold-bright">
        {mode === "login" ? "登 录" : "注 册"}
      </h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="text-[10px] tracking-wider text-faint">用户名</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-3 py-2.5 text-sm outline-none focus:border-gold/50"
            autoComplete="username"
            required
          />
        </div>
        <div>
          <label className="text-[10px] tracking-wider text-faint">密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-3 py-2.5 text-sm outline-none focus:border-gold/50"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={6}
            required
          />
        </div>
        {error && <p className="text-[11px] text-down">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg border border-gold/60 bg-gold/15 py-3 font-display text-[14px] tracking-wider text-gold-bright hover:bg-gold/25 disabled:opacity-50"
        >
          {busy ? "提交中…" : mode === "login" ? "登录" : "创建账号"}
        </button>
      </form>
      <p className="mt-4 text-center text-[11px] text-muted">
        {mode === "login" ? (
          <>
            还没有账号？{" "}
            <Link href="/register" className="text-gold-bright underline underline-offset-4">
              注册
            </Link>
          </>
        ) : (
          <>
            已有账号？{" "}
            <Link href="/login" className="text-gold-bright underline underline-offset-4">
              登录
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
