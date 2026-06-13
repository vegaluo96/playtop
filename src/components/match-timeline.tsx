"use client";

/**
 * 比赛直播时间轴(移动/桌面共用):
 *   重要事件 = 双列时间轴(主队左/客队右/分钟居中,状态节点横贯)
 *   文字直播 = 整句播报流(最新在上)
 * 数据 = AF 真实事件 + 滚球统计差分合成事件(events-synth),不含任何虚构。
 */
import { useState } from "react";

export interface TLRow {
  m: string;
  side: "h" | "a" | "mid";
  kind: string;
  text: string;
  live: string;
}
export interface TLData {
  rows: TLRow[];
  corners: { h: number; a: number } | null;
  ht: string | null;
}

/** kind → [图标, 底色, 字色] */
const ICON: Record<string, [string, string, string]> = {
  goal: ["●", "var(--success-bg)", "var(--green)"],
  yellow: ["▮", "var(--selected-bg-strong)", "var(--gold)"],
  red: ["▮", "var(--danger-bg)", "var(--red)"],
  sub: ["⇄", "var(--info-bg)", "var(--home)"],
  var: ["V", "var(--neutral-bg)", "var(--fg-3)"],
  corner: ["⚑", "var(--event-corner-bg)", "var(--event-corner)"],
  sot: ["◎", "var(--success-bg-soft)", "var(--green)"],
  soff: ["○", "var(--neutral-bg-soft)", "var(--fg-3)"],
  offside: ["⚐", "var(--selected-bg)", "var(--gold-2)"],
};
const LEGEND: [string, string][] = [
  ["●", "进球"], ["▮", "红黄牌"], ["⇄", "换人"], ["⚑", "角球"], ["◎", "射正"], ["○", "射偏"], ["⚐", "越位"],
];
/** 重要事件视图保留的 kind(文字直播显示全部) */
const KEY_KINDS = new Set(["goal", "yellow", "red", "sub", "var", "kickoff", "ht", "2h", "ft"]);

export function MatchTimeline({ tl, home, away, live }: { tl: TLData; home: string; away: string; live: boolean }) {
  const [mode, setMode] = useState<"key" | "text">("key");
  const rows = mode === "key" ? tl.rows.filter((r) => KEY_KINDS.has(r.kind)) : tl.rows;

  const icon = (kind: string) => {
    const ic = ICON[kind] ?? ICON.var;
    return (
      <span style={{ flexShrink: 0, width: 20, height: 20, borderRadius: 5, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, background: ic[1], color: ic[2] }}>
        {ic[0]}
      </span>
    );
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
      {/* 头部:标题 + LIVE + 角球数 + 视图切换 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 800 }}>比赛直播</span>
        {live && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />
            <span className="mono" style={{ fontSize: 11.5, color: "var(--red)", fontWeight: 800 }}>LIVE</span>
          </span>
        )}
        {tl.corners && (
          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 5, padding: "2px 7px" }}>
            角球 {tl.corners.h}-{tl.corners.a}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {([["key", "重要事件"], ["text", "文字直播"]] as const).map(([k, label]) => (
          <span key={k} onClick={() => setMode(k)} style={{ fontSize: 11, fontWeight: 700, cursor: "pointer", borderRadius: 6, padding: "3px 9px", background: mode === k ? "var(--selected-bg)" : "var(--inset)", color: mode === k ? "var(--gold)" : "var(--fg-3)" }}>
            {label}
          </span>
        ))}
      </div>

      {/* 双列表头 */}
      {mode === "key" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 44px 1fr", padding: "6px 12px", borderBottom: "1px solid var(--line-soft)" }}>
	          <span style={{ fontSize: 11.5, fontWeight: 750, color: "var(--home)", textAlign: "right" }}>{home}</span>
          <span />
	          <span style={{ fontSize: 11.5, fontWeight: 750, color: "var(--team-away)" }}>{away}</span>
        </div>
      )}

      <div style={{ maxHeight: 420, overflowY: "auto", padding: "4px 12px 8px" }}>
        {rows.length === 0 && <div style={{ padding: "16px 0", fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>暂无事件数据,开赛后更新</div>}
        {rows.map((r, i) =>
          r.side === "mid" ? (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0" }}>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
              <span style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)", whiteSpace: "nowrap" }}>{r.text}</span>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>
          ) : mode === "key" ? (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 44px 1fr", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0 }}>
                {r.side === "h" && (
                  <>
                    <span style={{ fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.text}</span>
                    {icon(r.kind)}
                  </>
                )}
              </span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>{r.m}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                {r.side === "a" && (
                  <>
                    {icon(r.kind)}
                    <span style={{ fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.text}</span>
                  </>
                )}
              </span>
            </div>
          ) : (
            <div key={i} style={{ display: "flex", gap: 9, padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="mono" style={{ flexShrink: 0, width: 38, fontSize: 11, color: "var(--fg-3)", paddingTop: 1 }}>{r.m}</span>
              {icon(r.kind)}
              <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg-mid)", lineHeight: 1.6 }}>{r.live}</span>
            </div>
          ),
        )}
      </div>

      {/* 图例 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "7px 12px", borderTop: "1px solid var(--line-soft)" }}>
        {LEGEND.map(([g, label]) => (
	          <span key={label} style={{ fontSize: 11.5, color: "var(--fg-3)", display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ color: "var(--fg-2)" }}>{g}</span>{label}
          </span>
        ))}
	        <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>角球/射正等由官方滚球统计差分还原</span>
      </div>
    </div>
  );
}

export interface WeatherData {
  temp: number;
  text: string;
  humidity: number;
  wind: number;
  pressure: number;
  src: string;
}

/** 球场天气卡:数据拿不到时上游为 null,本组件不渲染 */
export function WeatherCard({ w, style }: { w: WeatherData | null; style?: React.CSSProperties }) {
  if (!w) return null;
  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", ...style }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", marginBottom: 8 }}>球场天气 · 开球时刻预报</div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flexShrink: 0, textAlign: "center" }}>
          <span className="mono" style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{w.temp}°</span>
          <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 3 }}>{w.text}</div>
        </div>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[[`${w.humidity}%`, "湿度"], [`${w.wind} m/s`, "风速"], [`${w.pressure} hPa`, "气压"]].map(([val, label]) => (
            <div key={label} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 0", textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 12, fontWeight: 800 }}>{val}</div>
	              <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 1 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
	      <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 8 }}>来源:{w.src} · 天气影响草皮速度与传控质量,雨雪大风利守不利攻</div>
    </div>
  );
}
