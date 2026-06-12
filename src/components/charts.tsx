"use client";

/** 水位/指数折线图(设计稿 chartEl 移植:网格 3 线 + 变盘虚线 + 端点圆) */

export interface ChartRow {
  t: string;
  h: number;
  a: number;
  d?: number;
  chg?: boolean;
}

export function LineChart({ rows, id }: { rows: ChartRow[]; id: string }) {
  if (rows.length < 2)
    return (
      <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--fg-3)" }}>
        走势数据积累中(需 ≥2 帧快照)
      </div>
    );
  const W = 320, H = 118, L = 34, R = 10, T = 14, B = 18;
  const hasD = rows[0].d !== undefined;
  const vals: number[] = [];
  rows.forEach((r) => {
    vals.push(r.h, r.a);
    if (hasD) vals.push(r.d!);
  });
  const min = Math.min(...vals) - 0.02;
  const max = Math.max(...vals) + 0.02;
  const x = (i: number) => L + (i * (W - L - R)) / (rows.length - 1);
  const y = (v: number) => T + ((max - v) * (H - T - B)) / (max - min);
  const pts = (k: "h" | "a" | "d") => rows.map((r, i) => `${x(i)},${y((r[k] ?? 0) as number)}`).join(" ");
  const ci = rows.findIndex((r) => r.chg);
  const labelIdx = new Set([0, Math.floor(rows.length / 2), rows.length - 1]);
  return (
    <svg key={id} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {[0, 1, 2].map((g) => {
        const v = max - ((max - min) * g) / 2;
        return (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={L - 5} y={y(v) + 3} fill="var(--fg-3)" fontSize="8" textAnchor="end" fontFamily="IBM Plex Mono">
              {v.toFixed(2)}
            </text>
          </g>
        );
      })}
      {ci >= 0 && (
        <g>
          <line x1={x(ci)} x2={x(ci)} y1={T - 4} y2={H - B} stroke="var(--accent-2)" strokeDasharray="3 3" strokeWidth="1" />
          <text x={x(ci)} y={T - 6} fill="var(--accent-2)" fontSize="8" textAnchor="middle" fontWeight="700">
            变盘
          </text>
        </g>
      )}
      <polyline points={pts("h")} fill="none" stroke="var(--home)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <polyline points={pts("a")} fill="none" stroke="var(--team-away)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {hasD && <polyline points={pts("d")} fill="none" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />}
      {rows.map((r, i) =>
        labelIdx.has(i) ? (
          <text key={i} x={x(i)} y={H - 5} fill="var(--fg-3)" fontSize="8" textAnchor={i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"}>
            {r.t}
          </text>
        ) : null,
      )}
      <circle cx={x(rows.length - 1)} cy={y(rows[rows.length - 1].h)} r="2.6" fill="var(--home)" />
      <circle cx={x(rows.length - 1)} cy={y(rows[rows.length - 1].a)} r="2.6" fill="var(--team-away)" />
      {hasD && <circle cx={x(rows.length - 1)} cy={y(rows[rows.length - 1].d!)} r="2.4" fill="var(--fg-2)" />}
    </svg>
  );
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 14, justifyContent: "center", padding: "6px 0 4px" }}>
      {items.map((it) => (
        <span key={it.label} style={{ fontSize: 11, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 2, background: it.color, borderRadius: 2 }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** 主平客概率条 */
export function ProbBar({ pH, pD, pA }: { pH: number; pD: number; pA: number }) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "var(--home)", fontWeight: 700 }}>
          主胜 <span className="mono">{pH}%</span>
        </span>
        <span style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 700 }}>
          平 <span className="mono">{pD}%</span>
        </span>
        <span style={{ fontSize: 11, color: "var(--team-away)", fontWeight: 700 }}>
          客胜 <span className="mono">{pA}%</span>
        </span>
      </div>
      <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 2, marginBottom: 9 }}>
        <div style={{ background: "var(--home)", width: `${pH}%` }} />
        <div style={{ background: "var(--line)", width: `${pD}%` }} />
        <div style={{ background: "var(--team-away)", width: `${pA}%` }} />
      </div>
    </>
  );
}
