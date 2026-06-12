"use client";

/**
 * 盘路/同赔/疲劳/凯利汇总条(移动/桌面共用),数据见 src/server/views/insights.ts。
 * 全部由本站归档真实数据推导;样本不足时各卡自行隐藏或如实标注。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

const RES_STYLE: Record<string, { bg: string; c: string }> = {
  赢: { bg: "rgba(46,204,138,.16)", c: "var(--green)" },
  赢半: { bg: "rgba(46,204,138,.10)", c: "var(--green)" },
  走: { bg: "rgba(139,148,168,.14)", c: "#959ba6" },
  输半: { bg: "rgba(240,67,79,.10)", c: "var(--red)" },
  输: { bg: "rgba(240,67,79,.16)", c: "var(--red)" },
  大: { bg: "rgba(233,185,73,.16)", c: "var(--gold)" },
  大半: { bg: "rgba(233,185,73,.10)", c: "var(--gold)" },
  小: { bg: "rgba(91,157,255,.16)", c: "#5b9dff" },
  小半: { bg: "rgba(91,157,255,.10)", c: "#5b9dff" },
};

const box: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12 };

/** 单队单市场盘路卡:战绩汇总头 + 近 N 场明细 */
function RoadCard({ team, color, data, kind }: { team: string; color: string; data: V; kind: "ah" | "ou" }) {
  const agg = data?.agg;
  const rows: V[] = data?.rows ?? [];
  const label = kind === "ah" ? ["赢", "走", "输", "赢盘率"] : ["大", "走", "小", "大球率"];
  return (
    <div style={{ ...box, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--line)" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 800, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{team}</span>
        <span style={{ flex: 1 }} />
        {agg?.n > 0 ? (
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-2)", whiteSpace: "nowrap" }}>
            {agg.win}{label[0]} {agg.push}{label[1]} {agg.lose}{label[2]}
            {agg.rate != null && <span style={{ color: "var(--gold)", fontWeight: 800 }}> · {label[3]} {agg.rate}%</span>}
            {agg.streak !== "—" && <span style={{ color: "var(--fg-mid)", fontWeight: 700 }}> · {agg.streak}</span>}
          </span>
        ) : (
          <span style={{ fontSize: 10, color: "var(--fg-3)" }}>归档积累中</span>
        )}
      </div>
      {rows.map((r: V, i: number) => {
        const s = RES_STYLE[r.res] ?? RES_STYLE.走;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "44px 1fr 22px 44px 1fr 38px", gap: 4, padding: "6px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{r.d}</span>
            <span style={{ fontSize: 11, color: "var(--fg-mid)", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.opp}</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: r.ha === "主" ? "var(--home)" : "var(--gold)" }}>{r.ha}</span>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textAlign: "center" }}>{r.score}</span>
            <span style={{ fontSize: 10, color: "var(--fg-2)", textAlign: "right", whiteSpace: "nowrap" }}>{r.line}</span>
            <span style={{ justifySelf: "end", width: 30, textAlign: "center", fontSize: 9.5, fontWeight: 800, borderRadius: 5, padding: "2px 0", background: s.bg, color: s.c }}>{r.res}</span>
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
      <div style={{ fontSize: 13, fontWeight: 700, margin: "8px 4px" }}>让球盘路 <span style={{ fontSize: 9.5, color: "var(--fg-3)", fontWeight: 400 }}>临场盘 × 官方比分 · 近 10 场</span></div>
      <div style={grid}>
        <RoadCard team={home} color="var(--home)" data={ins.road.home?.ah} kind="ah" />
        <RoadCard team={away} color="var(--gold)" data={ins.road.away?.ah} kind="ah" />
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, margin: "14px 4px 8px" }}>大小盘路</div>
      <div style={grid}>
        <RoadCard team={home} color="var(--home)" data={ins.road.home?.ou} kind="ou" />
        <RoadCard team={away} color="var(--gold)" data={ins.road.away?.ou} kind="ou" />
      </div>
    </>
  );
}

/** ③ 同赔历史:初盘三元组 ±0.03 匹配本站归档完场赛事 */
export function SameOddsCard({ so }: { so: V }) {
  if (!so) return null;
  const pct = (x: number) => (so.n > 0 ? Math.round((x / so.n) * 100) : 0);
  return (
    <div style={{ ...box, padding: "10px 14px", marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800 }}>同赔历史</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--fg-2)" }}>初盘 {so.triple} · ±0.03</span>
      </div>
      {so.n === 0 ? (
        <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "6px 0" }}>暂无同赔完场样本,随归档积累自动出现</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            {[["主胜", so.w, "var(--green)"], ["平局", so.dr, "#959ba6"], ["客胜", so.l, "var(--red)"]].map(([lab, n, c]) => (
              <div key={lab as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 0", textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: c as string }}>{pct(n as number)}%</div>
                <div style={{ fontSize: 9, color: "var(--fg-3)", marginTop: 1 }}>{lab as string} {n as number} 场</div>
              </div>
            ))}
          </div>
          {(so.samples ?? []).map((s: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line-soft)" }}>
              <span style={{ flex: 1, fontSize: 10.5, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.m}</span>
              <span className="mono" style={{ fontSize: 10.5, fontWeight: 700 }}>{s.score}</span>
              <span style={{ fontSize: 10, fontWeight: 800, color: s.res === "胜" ? "var(--green)" : s.res === "负" ? "var(--red)" : "#959ba6" }}>{s.res}</span>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "var(--fg-4)", paddingTop: 6 }}>共 {so.n} 场同赔样本 · 自本站归档起,随时间变厚</div>
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
        <span className="mono" style={{ fontSize: 10.5, color: f.restDays != null && f.restDays <= 3 ? "var(--red)" : "var(--fg-2)", whiteSpace: "nowrap" }}>
          {f.restDays != null ? `休整 ${f.restDays} 天` : "近期无收录赛事"}
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: f.next7 >= 2 ? "var(--gold)" : "var(--fg-2)", whiteSpace: "nowrap" }}>未来7天 {f.next7} 赛</span>
      </div>
    );
  return (
    <div style={{ ...box, padding: "10px 14px", ...style }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>体能与赛程 <span style={{ fontSize: 9, color: "var(--fg-3)", fontWeight: 400 }}>仅统计本站收录赛事</span></div>
      {row(home, "var(--home)", fa.home)}
      {row(away, "var(--gold)", fa.away)}
      <div style={{ fontSize: 9, color: "var(--fg-4)", paddingTop: 4 }}>休整 ≤3 天或一周多赛,轮换与体能因素对盘口影响加大</div>
    </div>
  );
}

/** ④ 升降盘 + 返还率 + ② 离散度 汇总条(百家对比页顶部) */
export function CompMetaBar({ comp }: { comp: V }) {
  const t = comp?.trend;
  const m = comp?.euMeta;
  if (!t?.ah?.dir && !t?.ou?.dir && !m) return null;
  const dirText = (d: V) => d && `${d.up} 升 · ${d.down} 降 · ${d.flat} 持平`;
  const retText = (x: V) => (x?.ret0 != null && x?.ret1 != null ? `返还率 ${x.ret0}%→${x.ret1}%` : null);
  const items: [string, string | null][] = [
    ["亚盘", [dirText(t?.ah?.dir), retText(t?.ah)].filter(Boolean).join(" · ") || null],
    ["大小", [dirText(t?.ou?.dir), retText(t?.ou)].filter(Boolean).join(" · ") || null],
    ["离散度", m ? `主 ${m.disp.h} / 平 ${m.disp.d} / 客 ${m.disp.a}(${m.books} 家)` : null],
  ];
  return (
    <div style={{ ...box, padding: "9px 14px", marginBottom: 12 }}>
      {items.filter(([, v]) => v).map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0" }}>
          <span style={{ flexShrink: 0, width: 44, fontSize: 10, fontWeight: 800, color: "var(--fg-2)" }}>{k}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-mid)" }}>{v}</span>
        </div>
      ))}
      {m && <div style={{ fontSize: 9, color: "var(--fg-4)", paddingTop: 5, lineHeight: 1.6 }}>{m.method}</div>}
    </div>
  );
}

/** ⑥ 角球参考(更多玩法页脚注) */
export function CornersRefNote({ cr, home, away }: { cr: V; home: string; away: string }) {
  if (!cr) return null;
  return (
    <div style={{ ...box, padding: "9px 14px", marginTop: 4 }}>
      <span style={{ fontSize: 10.5, color: "var(--fg-2)", lineHeight: 1.7 }}>
        角球参考:{home} 近 {cr.h.n} 场场均角球合计 <span className="mono" style={{ color: "var(--gold)", fontWeight: 800 }}>{cr.h.avg}</span>
        {" "}· {away} 近 {cr.a.n} 场 <span className="mono" style={{ color: "var(--gold)", fontWeight: 800 }}>{cr.a.avg}</span>
        {" "}→ 合成参考 <span className="mono" style={{ color: "var(--gold)", fontWeight: 800 }}>{cr.ref}</span>,可对照上方角球盘口。
      </span>
    </div>
  );
}
