"use client";

/**
 * 盘路/同赔/疲劳/市场分歧汇总条(移动/桌面共用),数据见 src/server/views/insights.ts。
 * 全部由本站归档真实数据推导;归档样本未达阈值时各卡自行隐藏或如实标注。
 */

import { MarketValue } from "./market-cell";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

const RES_STYLE: Record<string, { bg: string; c: string }> = {
  赢: { bg: "var(--success-bg)", c: "var(--green)" },
  赢半: { bg: "var(--success-bg-soft)", c: "var(--green)" },
  走: { bg: "var(--neutral-bg)", c: "var(--fg-3)" },
  输半: { bg: "var(--danger-bg-soft)", c: "var(--red)" },
  输: { bg: "var(--danger-bg)", c: "var(--red)" },
  大: { bg: "var(--selected-bg-strong)", c: "var(--gold)" },
  大半: { bg: "var(--selected-bg)", c: "var(--gold)" },
  小: { bg: "var(--info-bg)", c: "var(--home)" },
  小半: { bg: "var(--info-bg-soft)", c: "var(--home)" },
};

const box: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12 };

function MiniMetric({ v, color = "var(--fg-mid)", dim = false, suffix = "" }: { v: string | number | null | undefined; color?: string; dim?: boolean; suffix?: string }) {
  return (
    <MarketValue
      v={v == null || v === "" ? "—" : `${v}${suffix}`}
      className="mono"
      small
      dim={dim}
      style={{ justifyContent: "flex-start", color, fontWeight: 800 }}
    />
  );
}

/** 单队单市场盘路卡:战绩汇总头 + 近 N 场明细 */
function RoadCard({ team, color, data, kind }: { team: string; color: string; data: V; kind: "ah" | "ou" }) {
  const agg = data?.agg;
  const rows: V[] = data?.rows ?? [];
  const label = kind === "ah" ? ["赢", "走", "输", "赢盘率"] : ["大", "走", "小", "大球率"];
  return (
    <div style={{ ...box, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 800, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{team}</span>
        <span style={{ flex: 1 }} />
        {agg?.n > 0 ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
            {[[agg.win, label[0]], [agg.push, label[1]], [agg.lose, label[2]]].map(([n, lab]) => (
              <div key={lab as string} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11.5, color: "var(--fg-2)" }}>
                <MiniMetric v={n as number} dim />
                <span>{lab as string}</span>
              </div>
            ))}
            {agg.rate != null && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11.5, color: "var(--fg-2)" }}>
                <span>{label[3]}</span>
                <MiniMetric v={agg.rate} suffix="%" color="var(--gold)" />
              </div>
            )}
            {agg.streak !== "—" && <span style={{ fontSize: 11.5, color: "var(--fg-mid)", fontWeight: 700 }}>{agg.streak}</span>}
          </div>
        ) : (
          <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>归档积累中</span>
        )}
      </div>
      {rows.map((r: V, i: number) => {
        const s = RES_STYLE[r.res] ?? RES_STYLE.走;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "48px 1fr 24px 48px 58px 40px", gap: 5, padding: "7px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{r.d}</span>
            <span style={{ fontSize: 12, color: "var(--fg-mid)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.opp}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: r.ha === "主" ? "var(--home)" : "var(--team-away)" }}>{r.ha}</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, textAlign: "center" }}>{r.score}</span>
            <MarketValue v={r.line} className="" small dim style={{ justifyContent: "flex-end" }} />
            <span style={{ justifySelf: "end", width: 34, textAlign: "center", fontSize: 11.5, fontWeight: 800, borderRadius: 5, padding: "2px 0", background: s.bg, color: s.c }}>{r.res}</span>
          </div>
        );
      })}
    </div>
  );
}

/** ① 盘路榜:让球 + 大小,两队并排(窄屏自动纵排) */
export function RoadSection({ ins, home, away }: { ins: V; home: string; away: string }) {
  if (!ins?.road) return null;
  const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 10 };
  return (
    <>
      <div style={{ fontSize: 13.5, fontWeight: 750, margin: "8px 4px" }}>让球盘路 <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 400 }}>临场盘 × 官方比分 · 近 10 场</span></div>
      <div style={grid}>
        <RoadCard team={home} color="var(--home)" data={ins.road.home?.ah} kind="ah" />
        <RoadCard team={away} color="var(--team-away)" data={ins.road.away?.ah} kind="ah" />
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, margin: "14px 4px 8px" }}>大小盘路</div>
      <div style={grid}>
        <RoadCard team={home} color="var(--home)" data={ins.road.home?.ou} kind="ou" />
        <RoadCard team={away} color="var(--team-away)" data={ins.road.away?.ou} kind="ou" />
      </div>
    </>
  );
}

/** ③ 同赔历史:赛前末盘三元组 ±0.03 匹配本站归档完场赛事 */
export function SameOddsCard({ so }: { so: V }) {
  if (!so) return null;
  const pct = (x: number) => (so.n > 0 ? Math.round((x / so.n) * 100) : 0);
  return (
    <div style={{ ...box, padding: "10px 14px", marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800 }}>同赔历史</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-2)" }}>
          <span style={{ fontSize: 11.5 }}>赛前末盘</span>
          <MarketValue v={so.triple} small dim style={{ justifyContent: "flex-end" }} />
          <span className="mono" style={{ fontSize: 11.5 }}>±0.03</span>
        </span>
      </div>
      {so.n === 0 ? (
        <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "6px 0" }}>暂无同赔完场样本,随归档积累自动出现</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            {[["主胜", so.w, "var(--home)"], ["平局", so.dr, "var(--fg-3)"], ["客胜", so.l, "var(--team-away)"]].map(([lab, n, c]) => (
              <div key={lab as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 0", textAlign: "center" }}>
                <MarketValue v={`${pct(n as number)}%`} className="mono" small style={{ justifyContent: "center", color: c as string, fontSize: 14, fontWeight: 800 }} />
                <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 1 }}>{lab as string} {n as number} 场</div>
              </div>
            ))}
          </div>
          {(so.samples ?? []).map((s: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line-soft)" }}>
              <span style={{ flex: 1, fontSize: 11.5, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.m}</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 700 }}>{s.score}</span>
              <span style={{ fontSize: 11, fontWeight: 800, color: s.res === "胜" ? "var(--green)" : s.res === "负" ? "var(--red)" : "var(--fg-3)" }}>{s.res}</span>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", paddingTop: 6 }}>共 {so.n} 场同赔样本 · 自本站归档起,随时间变厚</div>
        </>
      )}
    </div>
  );
}

/** ⑤ 体能与赛程 */
export function FatigueCard({ fa, home, away, style }: { fa: V; home: string; away: string; style?: React.CSSProperties }) {
  if (!fa?.home && !fa?.away) return null;
  const row = (name: string, color: string, f: V) =>
    f && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, fontWeight: 700, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
        <span className="mono" style={{ fontSize: 11.5, color: f.restDays != null && f.restDays <= 3 ? "var(--red)" : "var(--fg-2)", whiteSpace: "nowrap" }}>
          {f.restDays != null ? `休整 ${f.restDays} 天` : "近期无收录赛事"}
        </span>
        <span className="mono" style={{ fontSize: 11.5, color: f.next7 >= 2 ? "var(--gold)" : "var(--fg-2)", whiteSpace: "nowrap" }}>未来7天 {f.next7} 赛</span>
      </div>
    );
  return (
    <div style={{ ...box, padding: "10px 14px", ...style }}>
      <div style={{ fontSize: 12.5, fontWeight: 750, marginBottom: 4 }}>体能与赛程 <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 400 }}>仅统计本站收录赛事</span></div>
      {row(home, "var(--home)", fa.home)}
      {row(away, "var(--team-away)", fa.away)}
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", paddingTop: 4 }}>休整 ≤3 天或一周多赛,轮换与体能因素对指数影响加大</div>
    </div>
  );
}

/** ⑥ 角球参考(更多玩法页脚注) */
export function CornersRefNote({ cr, home, away }: { cr: V; home: string; away: string }) {
  if (!cr) return null;
  return (
    <div style={{ ...box, padding: "9px 14px", marginTop: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 7 }}>角球参考</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[
          [home, `近 ${cr.h.n} 场`, cr.h.avg],
          [away, `近 ${cr.a.n} 场`, cr.a.avg],
          ["合成参考", "本站归档", cr.ref],
        ].map(([name, sub, v]) => (
          <div key={name as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 8px" }}>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name as string}</div>
            <MiniMetric v={v as string | number} color="var(--gold)" />
            <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{sub as string}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-3)", paddingTop: 7, lineHeight: 1.6 }}>可对照上方角球指数,仅作数据参考。</div>
    </div>
  );
}
