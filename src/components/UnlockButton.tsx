"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function UnlockButton({
  matchId,
  price,
  loggedIn,
  balance,
}: {
  matchId: number;
  price: number;
  loggedIn: boolean;
  balance: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insufficient = loggedIn && balance !== null && balance < price;

  async function unlock() {
    if (!loggedIn) {
      router.push("/login");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/matches/${matchId}/unlock`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "解锁失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-center">
      <button
        onClick={unlock}
        disabled={busy || insufficient}
        className="w-full rounded-lg border border-gold/60 bg-gold/15 py-3 font-display text-[15px] tracking-wide text-gold-bright transition-colors hover:bg-gold/25 disabled:opacity-50"
      >
        {busy ? "解锁中…" : loggedIn ? `${price} 积分 · 解锁全文研报` : "登录后解锁研报"}
      </button>
      {insufficient && (
        <p className="mt-2 text-[11px] text-down">
          当前余额 {balance} 分，不足 {price} 分——平台不提供自助充值，请联系管理员添加积分。
        </p>
      )}
      {error && <p className="mt-2 text-[11px] text-down">{error}</p>}
      <p className="mt-2 text-[10px] leading-5 text-faint">
        一次解锁覆盖本场赛前全部实时改版 · 赛后所有人免费可读
        <br />
        若比赛延期/腰斩，积分自动全额退回
      </p>
    </div>
  );
}
