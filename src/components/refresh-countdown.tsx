"use client";

import { useEffect, useMemo, useState } from "react";

type FreshLike = {
  idx?: number | null;
  line?: string | null;
  intervalMs?: number | null;
};
/** 临近档(≤30 分钟,含滚球)才做秒级倒计时;远期只显示"距开赛 X · 每 N 刷新" */
const COUNTDOWN_FROM_TIER = 5;

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
    // 远期比赛不做秒级倒计时(会显示十几小时、且随抓取跳动),只显示"距开赛 X · 每 N 刷新"
    const idx = Number(fresh?.idx);
    if (Number.isFinite(idx) && idx < COUNTDOWN_FROM_TIER) return fresh?.line ?? "等待刷新";
    const interval = Number(fresh?.intervalMs);
    if (!Number.isFinite(interval) || interval <= 0) return fresh?.line ?? "等待刷新";
    const anchor = Number.isFinite(Number(oddsAt)) ? Number(oddsAt) : Number.isFinite(Number(fallbackAt)) ? Number(fallbackAt) : mountedAt;
    if (!Number.isFinite(anchor) || anchor <= 0) return "等待刷新";
    return `下次刷新 ${countdownText(anchor + interval - now)}`;
  }, [fallbackAt, finished, fresh?.intervalMs, mountedAt, now, oddsAt]);
}

export function RefreshCountdownText(args: {
  finished?: boolean;
  fresh?: FreshLike | null;
  oddsAt?: number | null;
  fallbackAt?: number | null;
}) {
  return <>{useRefreshCountdown(args)}</>;
}
