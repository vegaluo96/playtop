import type { ReactNode } from "react";

/** 共享展示组件（服务端可渲染） */

export function SectionTitle({ index, children }: { index?: string; children: ReactNode }) {
  return (
    <div className="mt-7 mb-3 flex items-center gap-3">
      {index && (
        <span className="font-display text-gold text-xs tracking-[0.3em]">{index}</span>
      )}
      <h2 className="font-display text-[15px] tracking-widest text-ink">{children}</h2>
      <div className="gold-rule flex-1" />
    </div>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="text-[10px] tracking-[0.2em] text-faint uppercase">{label}</div>
      <div className={`tabular mt-1 text-lg font-semibold ${accent ? "text-gold-bright" : "text-ink"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

export function ProbBar({ home, draw, away, labels = true }: { home: number; draw: number; away: number; labels?: boolean }) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    <div>
      {labels && (
        <div className="tabular mb-1 flex justify-between text-[11px] text-muted">
          <span>
            主胜 <b className="text-gold-bright">{pct(home)}</b>
          </span>
          <span>
            平局 <b className="text-ink">{pct(draw)}</b>
          </span>
          <span>
            客胜 <b className="text-info">{pct(away)}</b>
          </span>
        </div>
      )}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-overlay">
        <div className="bg-gold" style={{ width: pct(home) }} />
        <div className="bg-faint" style={{ width: pct(draw) }} />
        <div className="bg-info/70" style={{ width: pct(away) }} />
      </div>
    </div>
  );
}

export function LiveBadge({ text = "实时数据" }: { text?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface px-2.5 py-1 text-[10px] tracking-widest text-up">
      <span className="pulse-dot" />
      {text}
    </span>
  );
}

export function Tag({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "gold" | "up" | "down" | "info" }) {
  const tones: Record<string, string> = {
    default: "border-hairline text-muted",
    gold: "border-gold/40 text-gold-bright",
    up: "border-up/40 text-up",
    down: "border-down/40 text-down",
    info: "border-info/40 text-info",
  };
  return (
    <span className={`inline-flex items-center rounded border bg-surface/60 px-1.5 py-0.5 text-[10px] tracking-wider ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function fmtCn(t: number): string {
  return new Date(t).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtDateCn(t: number): string {
  return new Date(t).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" });
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export const MARKET_LABEL: Record<string, string> = { "1x2": "胜平负", ou: "大小球", ah: "亚盘" };

export const STATUS_LABEL: Record<string, { text: string; tone: "default" | "gold" | "up" | "down" | "info" }> = {
  scheduled: { text: "待采集", tone: "default" },
  collecting: { text: "采集中", tone: "info" },
  ready: { text: "数据就绪", tone: "info" },
  analyzed: { text: "已建模", tone: "info" },
  published: { text: "赛前·研报已发布", tone: "gold" },
  in_play: { text: "比赛进行中", tone: "up" },
  finished: { text: "完场·待结算", tone: "info" },
  settled: { text: "已公开", tone: "up" },
  void: { text: "已作废", tone: "down" },
};
