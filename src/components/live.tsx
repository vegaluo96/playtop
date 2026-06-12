"use client";

/**
 * 行情终端微交互(不伪造数据,只渲染真实变化):
 * - <Flash>:字段值真实变化时背景闪动 1.3s + 方向残影 2.4s;布局零位移(箭头占位恒定)
 * - <HeartBeat>:盯盘心跳(呼吸点 + Live·Ns + 上次检查/下次刷新);worker 失联→盯盘暂停,
 *   轮询超时→数据延迟;无变化时只走心跳,绝不跳数字
 * - useNewIds:异动流新条目滑入(列表不重排)
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";

/** 每秒重渲染(供「Xs前」计时文案) */
export function useNow(ms = 1000): number {
  const [, setT] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return Date.now();
}

export function agoText(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "—";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return s < 2 ? "刚刚" : s < 60 ? `${s}s前` : s < 3600 ? `${Math.floor(s / 60)}m前` : `${Math.floor(s / 3600)}h前`;
}

/** 近窗变化进场即闪的时间窗:刚打开页面也能看到「刚刚变过」的字段在跳 */
const PULSE_WINDOW_MS = 5 * 60_000;

/**
 * 值变化 → 闪动+方向;数值用 ▲▼,非数值(盘口文本)闪金。
 * pulse(该值最近真实变化的时间戳)+ pulseDir:挂载时若变化发生在近窗内,主动闪一次——
 * 解决「变化发生在打开页面之前/轮询间隙,用户永远看不到跳动」;仍然只闪真实变化。
 */
export function Flash({ v, arrow = false, className, style, pulse, pulseDir }: { v: string | number | null | undefined; arrow?: boolean; className?: string; style?: CSSProperties; pulse?: number | null; pulseDir?: number }) {
  const prevRef = useRef<typeof v>(undefined);
  const pulsedRef = useRef(false);
  const [fx, setFx] = useState<{ dir: -1 | 0 | 1; key: number } | null>(null);
  useEffect(() => {
    if (pulsedRef.current) return;
    pulsedRef.current = true; // 仅挂载时机检查一次,后续交给真实值变化路径
    if (!pulse || Date.now() - pulse > PULSE_WINDOW_MS) return;
    const dir: -1 | 0 | 1 = pulseDir && pulseDir > 0 ? 1 : pulseDir && pulseDir < 0 ? -1 : 0;
    setFx({ dir, key: Date.now() });
    const t = setTimeout(() => setFx(null), 2400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = v;
    if (prev === undefined || v == null || prev == null || prev === v) return;
    const a = parseFloat(String(prev));
    const b = parseFloat(String(v));
    const dir: -1 | 0 | 1 = Number.isFinite(a) && Number.isFinite(b) && a !== b ? (b > a ? 1 : -1) : 0;
    setFx({ dir, key: Date.now() });
    const t = setTimeout(() => setFx(null), 2400);
    return () => clearTimeout(t);
  }, [v]);
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: 2, ...style }}>
      <span key={fx?.key ?? "s"} className={fx ? (fx.dir > 0 ? "flash-up" : fx.dir < 0 ? "flash-down" : "flash-gold") : undefined} style={{ borderRadius: 3 }}>
        {v}
      </span>
      {arrow && (
        <span
          style={{ fontSize: 8, width: 9, flexShrink: 0, color: fx && fx.dir > 0 ? "var(--up)" : "var(--down)", opacity: fx && fx.dir !== 0 ? 1 : 0, transition: "opacity .5s" }}
        >
          {fx && fx.dir < 0 ? "▼" : "▲"}
        </span>
      )}
    </span>
  );
}

export interface BeatState {
  lastAt: number | null;
  intervalMs: number;
  workerAt?: number | null;
}

/** 心跳行:● Live · 10s · 上次检查 3s前(可选 下次约 Ns) */
export function HeartBeat({ lastAt, intervalMs, workerAt, showNext = false, style }: BeatState & { showNext?: boolean; style?: CSSProperties }) {
  const now = useNow(1000);
  const workerDown = workerAt != null && now - workerAt > 3 * 60_000;
  const stale = lastAt != null && now - lastAt > intervalMs * 3;
  const nextS = lastAt != null ? Math.max(0, Math.ceil((lastAt + intervalMs - now) / 1000)) : null;
  const color = workerDown ? "var(--fg-3)" : stale ? "var(--gold)" : "var(--green)";
  const label = workerDown ? "盯盘暂停" : stale ? "数据延迟" : `Live · ${Math.round(intervalMs / 1000)}s`;
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9, color: "var(--fg-3)", whiteSpace: "nowrap", ...style }}>
      <span className={workerDown ? undefined : "breathe"} style={{ width: 5, height: 5, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ color, fontWeight: 700 }}>{label}</span>
      <span>· 上次检查 {agoText(lastAt, now)}</span>
      {showNext && nextS != null && !workerDown && !stale && <span>· 下次约 {nextS}s</span>}
    </span>
  );
}

/** 平台健康(/api/health)定期取一次:worker 心跳 + 当前滚球场次数 */
export function useHealth(): { workerAt: number | null; liveNow: number } {
  const [h, setH] = useState<{ workerAt: number | null; liveNow: number }>({ workerAt: null, liveNow: 0 });
  useEffect(() => {
    const load = () =>
      fetch("/api/health", { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => setH({ workerAt: j.workerAt ?? null, liveNow: Number(j.liveNow) || 0 }))
        .catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  return h;
}

/** worker 心跳(兼容旧用法) */
export function useWorkerBeat(): number | null {
  return useHealth().workerAt;
}

/**
 * 四个一级菜单的统一轮询:全站一条规则 —— 平台有滚球场次 3s,否则 10s
 * (liveNow 来自 /api/health,与列表/详情的「滚球加速」同源)。
 * 返回值直接喂给 PageHeader,页头「Live · Ns」即本页真实轮询节奏。
 */
export function useUnifiedPoll(load: () => void | Promise<void>): { lastAt: number | null; workerAt: number | null; intervalMs: number } {
  const { workerAt, liveNow } = useHealth();
  const intervalMs = liveNow > 0 ? 3_000 : 10_000;
  const [lastAt, setLastAt] = useState<number | null>(null);
  usePoll(async () => {
    try {
      await load();
    } finally {
      setLastAt(Date.now());
    }
  }, intervalMs);
  return { lastAt, workerAt, intervalMs };
}

/** 统一轮询:document.hidden 时暂停(省流量 + 长停留防御),回到前台立即刷一次 */
export function usePoll(fn: () => void | Promise<void>, intervalMs: number): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    void fnRef.current();
    const t = setInterval(() => {
      if (!document.hidden) void fnRef.current();
    }, intervalMs);
    const onVis = () => {
      if (!document.hidden) void fnRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);
}

/** 后台实际生效的抓取档位(/api/health intervals);open 置 true 时拉取,保证弹层展示的是当前生效值 */
export function useTierIntervals(open: boolean): number[] | null {
  const [iv, setIv] = useState<number[] | null>(null);
  useEffect(() => {
    if (!open) return;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.intervals)) setIv(j.intervals as number[]);
      })
      .catch(() => {});
  }, [open]);
  return iv;
}

/** 新出现的 id 集合(首帧不算新;800ms 后并入已知) */
export function useNewIds(ids: (string | number)[]): Set<string | number> {
  const known = useRef<Set<string | number> | null>(null);
  const [fresh, setFresh] = useState<Set<string | number>>(new Set());
  const key = ids.join(",");
  useEffect(() => {
    if (known.current == null) {
      known.current = new Set(ids);
      return;
    }
    const k = known.current;
    const add = ids.filter((id) => !k.has(id));
    ids.forEach((id) => k.add(id));
    if (add.length > 0) {
      setFresh(new Set(add));
      const t = setTimeout(() => setFresh(new Set()), 900);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fresh;
}
