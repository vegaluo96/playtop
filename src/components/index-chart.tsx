"use client";

/**
 * ZSKY 综合指数图(Robinhood/OKX 视觉):时间域坐标、网格、右侧价格轴、面积渐变、
 * 十字光标取值、开球分割线、变盘标记、区间切换(全部/24H/滚球)。
 * 数据 = 多书商聚合计价(src/server/views/composite.ts),纯 SVG 无外部依赖。
 */
import { useMemo, useRef, useState } from "react";
import { hhmm } from "@/lib/format";

export interface IdxPoint {
  t: number;
  v: number;
  line: number | null;
  n: number;
  phase: "pre" | "live";
}
export interface IdxData {
  points: IdxPoint[];
  markers: { t: number; from: number | null; to: number | null }[];
  method: string;
  books: number;
}

const W = 720;
const H = 240;
const PAD_L = 10;
const PAD_R = 64;
const PAD_T = 14;
const PAD_B = 26;

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) ?? mag * 10;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

export function IndexChart({
  data, kickoff, tz, unit, lineText, height = 200,
}: {
  data: IdxData;
  kickoff: number;
  tz: string;
  unit: string; // 例:净水 / 主胜概率
  lineText?: (line: number | null) => string; // 盘口翻译(ahText/ouText)
  height?: number;
}) {
  const [range, setRange] = useState<"all" | "24h" | "live">("all");
  const [hover, setHover] = useState<IdxPoint | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const pts = useMemo(() => {
    const all = data.points;
    if (range === "live") return all.filter((p) => p.phase === "live");
    if (range === "24h") {
      const end = all.length > 0 ? all[all.length - 1].t : Date.now();
      return all.filter((p) => p.t >= end - 24 * 3_600_000);
    }
    return all;
  }, [data.points, range]);

  const hasLive = data.points.some((p) => p.phase === "live");
  const ranges: { k: typeof range; label: string }[] = [
    { k: "all", label: "全部" },
    { k: "24h", label: "24H" },
    ...(hasLive ? ([{ k: "live", label: "滚球" }] as { k: typeof range; label: string }[]) : []),
  ];

  if (pts.length < 2)
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--fg-3)" }}>
        走势数据积累中(需 ≥2 个计价点)
      </div>
    );

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const vLo = Math.min(...pts.map((p) => p.v));
  const vHi = Math.max(...pts.map((p) => p.v));
  const padV = Math.max((vHi - vLo) * 0.15, 0.01);
  const lo = vLo - padV;
  const hi = vHi + padV;
  const x = (t: number) => PAD_L + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  const ticks = niceTicks(lo, hi);
  const xLabels = [t0, t0 + (t1 - t0) / 2, t1];
  const koX = kickoff >= t0 && kickoff <= t1 ? x(kickoff) : null;

  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(t1).toFixed(1)},${H - PAD_B} L${x(t0).toFixed(1)},${H - PAD_B} Z`;
  const markers = data.markers.filter((m) => m.t >= t0 && m.t <= t1);
  const last = pts[pts.length - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (px - PAD_L) / (W - PAD_L - PAD_R)));
    const tx = t0 + frac * (t1 - t0);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - tx) < Math.abs(best.t - tx)) best = p;
    setHover(best);
  };

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        {ranges.map((r) => (
          <span
            key={r.k}
            onClick={() => setRange(r.k)}
            style={{
              fontSize: 10, fontWeight: 700, cursor: "pointer", borderRadius: 6, padding: "2px 8px",
              background: range === r.k ? "rgba(233,185,73,.14)" : "var(--inset)",
              color: range === r.k ? "var(--gold)" : "var(--fg-3)",
            }}
          >
            {r.label}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
          {unit} <span style={{ color: "var(--gold)", fontWeight: 800 }}>{last.v}</span>
          {last.line != null && lineText && <span style={{ marginLeft: 6 }}>{lineText(last.line)}</span>}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height, display: "block", touchAction: "none" }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="idxFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(233,185,73,.28)" />
            <stop offset="100%" stopColor="rgba(233,185,73,0)" />
          </linearGradient>
        </defs>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(tk)} y2={y(tk)} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" />
            <text x={W - PAD_R + 6} y={y(tk) + 3} fontSize="10" fill="var(--fg-3)" className="mono">{tk}</text>
          </g>
        ))}
        {xLabels.map((tl, i) => (
          <text key={i} x={x(tl)} y={H - 8} fontSize="10" fill="var(--fg-3)" textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="mono">
            {hhmm(tl, tz)}
          </text>
        ))}
        {koX != null && (
          <g>
            <line x1={koX} x2={koX} y1={PAD_T} y2={H - PAD_B} stroke="var(--red)" strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
            <text x={koX + 4} y={PAD_T + 9} fontSize="9" fill="var(--red)">开球</text>
          </g>
        )}
        <path d={area} fill="url(#idxFill)" />
        <path d={path} fill="none" stroke="var(--gold)" strokeWidth="1.8" strokeLinejoin="round" />
        {markers.map((m, i) => {
          const p = pts.find((pp) => pp.t === m.t);
          return p ? <circle key={i} cx={x(p.t)} cy={y(p.v)} r="3.2" fill="var(--bg)" stroke="var(--gold)" strokeWidth="1.6" /> : null;
        })}
        <circle cx={x(last.t)} cy={y(last.v)} r="3.4" fill="var(--gold)">
          <animate attributeName="opacity" values="1;.35;1" dur="1.6s" repeatCount="indefinite" />
        </circle>
        {hover && (
          <g>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD_T} y2={H - PAD_B} stroke="var(--fg-3)" strokeWidth="1" strokeDasharray="2 3" />
            <circle cx={x(hover.t)} cy={y(hover.v)} r="4" fill="none" stroke="var(--fg)" strokeWidth="1.4" />
          </g>
        )}
      </svg>
      {hover && (
        <div
          className="mono"
          style={{
            position: "absolute", top: 26, left: `${Math.min(78, Math.max(2, ((hover.t - t0) / Math.max(1, t1 - t0)) * 100))}%`,
            background: "#171a22", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 9px",
            fontSize: 10, color: "var(--fg-mid)", pointerEvents: "none", whiteSpace: "nowrap", zIndex: 5,
          }}
        >
          <div style={{ color: "var(--fg-3)" }}>{hhmm(hover.t, tz)}{hover.phase === "live" ? " · 滚球" : ""}</div>
          <div>
            {unit} <span style={{ color: "var(--gold)", fontWeight: 800 }}>{hover.v}</span>
            {hover.line != null && lineText && <span style={{ marginLeft: 6 }}>{lineText(hover.line)}</span>}
          </div>
          {hover.phase === "pre" && <div style={{ color: "var(--fg-3)" }}>{hover.n} 家书商参与</div>}
        </div>
      )}
    </div>
  );
}
