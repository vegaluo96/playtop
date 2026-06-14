"use client";

import { useEffect, useMemo, useState } from "react";

type FreshLike = {
  idx?: number | null;
  line?: string | null;
  intervalMs?: number | null;
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function countdownText(ms: number): string {
  if (ms <= 0) return "即将刷新";
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function useRefreshCountdown(args: {
  finished?: boolean;
  fresh?: FreshLike | null;
  oddsAt?: number | null;
  fallbackAt?: number | null;
}): string {
  const { finished, fresh, oddsAt, fallbackAt } = args;
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    if (finished) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [finished]);

  return useMemo(() => {
    if (finished) return "已完场 · 数据已固化";
    // 把「每 N 刷新」改成活的倒计时:保留「距开赛 X」前缀(取 fresh.line 第一段),
    // 后半段换成到下次抓取的秒级倒计时(以最近一次抓取/请求为锚点 + 刷新间隔)。
    const interval = Number(fresh?.intervalMs);
    const anchor = Number.isFinite(Number(oddsAt)) ? Number(oddsAt) : Number.isFinite(Number(fallbackAt)) ? Number(fallbackAt) : mountedAt;
    const hasCountdown = Number.isFinite(interval) && interval > 0 && Number.isFinite(anchor) && anchor > 0;
    if (!hasCountdown) return fresh?.line ?? "等待刷新";
    const cd = `下次刷新 ${countdownText(anchor + interval - now)}`;
    const prefix = (fresh?.line ?? "").split(" · ")[0]?.trim();
    return prefix && /开赛|距/.test(prefix) ? `${prefix} · ${cd}` : cd;
  }, [fallbackAt, finished, fresh?.line, fresh?.intervalMs, mountedAt, now, oddsAt]);
}

export function RefreshCountdownText(args: {
  finished?: boolean;
  fresh?: FreshLike | null;
  oddsAt?: number | null;
  fallbackAt?: number | null;
}) {
  return <>{useRefreshCountdown(args)}</>;
}
