"use client";

/** 桌面中栏:比赛头 + 7 tab(盘口走势/百家对比/技术面/AI报告/阵容/情报/深挖) */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LineChart, type ChartRow } from "@/components/charts";
import { Flash } from "@/components/live";
import { hhmm } from "@/lib/format";
import { leagueColor } from "@/lib/leagues";
import type { DTab } from "./terminal";
import { SITE_HOST } from "@/lib/site";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

const TAB_DEFS: [DTab, string][] = [
  ["odds", "盘口走势"], ["comp", "百家对比"], ["tech", "技术面"], ["lineup", "阵容"], ["intel", "情报"], ["deep", "深挖"], ["report", "AI 报告"],
];

const FORM_STYLE: Record<string, { bg: string; c: string }> = {
  胜: { bg: "rgba(46,204,138,.16)", c: "#2ecc8a" },
  平: { bg: "rgba(139,148,168,.16)", c: "#959ba6" },
  负: { bg: "rgba(240,67,79,.16)", c: "#f0434f" },
};

export function CenterPane({
  detail: v, tab, setTab, pred, requestUnlock, tz, loggedIn,
}: {
  detail: V | null;
  tab: DTab;
  setTab: (t: DTab) => void;
  pred: V | null;
  requestUnlock: (t: { id: number; match: string; price: number }) => void;
  tz: string;
  loggedIn: boolean;
}) {
  const [deepV, setDeepV] = useState<V | null>(null);
  const [report, setReport] = useState<V | null>(null);
  const [copied, setCopied] = useState(false);
  const router = useRouter();
  const fid = v?.header?.id ?? null;

  useEffect(() => {
    setDeepV(null);
    setReport(null);
    setCopied(false);
  }, [fid]);

  useEffect(() => {
    if (tab === "deep" && fid && !deepV) {
      void fetch(`/api/match/${fid}?tz=${encodeURIComponent(tz)}&deep=1`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => j.ok && setDeepV(j.deep ?? {}));
    }
    if (tab === "report" && fid && !report) {
      void fetch(`/api/report/${fid}?tz=${encodeURIComponent(tz)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => j.ok && setReport(j));
    }
  }, [tab, fid, deepV, report, tz]);

  // 解锁后(pred.locked 变化)刷新报告
  useEffect(() => {
    if (pred && !pred.locked && report?.locked) setReport(null);
  }, [pred, report]);

  if (!v)
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-3)", fontSize: 12, minHeight: 0 }}>
        在左侧选择一场比赛
      </div>
    );

  const h = v.header;
  const copyLink = () => {
    try {
      void navigator.clipboard.writeText(`https://${SITE_HOST}/match/${h.id}`);
    } catch { /* ignore */ }
    setCopied(true);
  };

  const Card = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, ...style }}>{children}</div>
  );

  const trendCol = (title: string, data: { rows: V[]; chart: ChartRow[] }, cols: [string, string]) => (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        {title}
        {data.chart.length > 1 && <span className="mono" style={{ fontSize: 9, color: "var(--fg-4)", fontWeight: 400 }}>自 {data.chart[0].t} 归档</span>}
      </div>
      <Card style={{ padding: "10px 8px 4px" }}>
        <LineChart rows={data.chart} id={title} />
      </Card>
      <Card style={{ marginTop: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "52px 1fr 48px 48px", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
          {["时间", "盘口", cols[0], cols[1]].map((c, i) => (
            <span key={c} style={{ fontSize: 9, color: "var(--fg-3)", textAlign: i >= 2 ? "right" : "left" }}>{c}</span>
          ))}
        </div>
        {data.rows.length === 0 && <div style={{ padding: 12, fontSize: 10, color: "var(--fg-3)", textAlign: "center" }}>快照积累中</div>}
        {data.rows.map((r: V, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "52px 1fr 48px 48px", padding: "6px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{r.t}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: r.chg ? "var(--gold)" : "var(--fg-mid)", whiteSpace: "nowrap" }}>{r.text}{r.chg ? <span style={{ fontSize: 8.5, marginLeft: 4 }}>变盘</span> : null}</span>
            <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{r.h}</span>
            <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{r.a}</span>
          </div>
        ))}
      </Card>
    </div>
  );

  const compCol = (title: string, rows: V[], eu = false) => (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px" }}>{title}</div>
      <Card style={{ overflow: "hidden" }}>
        {rows.length === 0 && <div style={{ padding: 12, fontSize: 10, color: "var(--fg-3)", textAlign: "center" }}>数据积累中</div>}
        {rows.map((c: V) => (
          <div key={c.co} style={{ display: "grid", gridTemplateColumns: eu ? "64px 1fr" : "64px 1fr 1fr", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 11, fontWeight: 700 }}>{c.co}</span>
            {eu ? (
              <span>
                <span className="mono" style={{ display: "block", fontSize: 10, color: "var(--fg-3)" }}>{c.iW}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-mid)" }}>{c.nW}</span>
              </span>
            ) : (
              <>
                <span>
                  <span style={{ display: "block", fontSize: 10, color: "var(--fg-2)" }}>{c.iText}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{c.iW}</span>
                </span>
                <span>
                  <span style={{ display: "block", fontSize: 10, fontWeight: 700, color: c.changed ? "var(--gold)" : "var(--fg-mid)" }}>{c.nText}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-mid)" }}>{c.nW}</span>
                </span>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
  );

  const pitch = (side: V, color: string) => (
    <div style={{ background: "linear-gradient(180deg,#0f2018,#0c1812)", border: "1px solid #1b3023", borderRadius: 12, padding: "16px 8px", display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 320, height: "100%", boxSizing: "border-box" }}>
      {side.rows.map((row: string[], i: number) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-evenly" }}>
          {row.map((name) => (
            <div key={name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 64 }}>
              <span className="mono" style={{ width: 26, height: 26, borderRadius: "50%", background: color, color: "#0a0b0f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800 }}>{name.slice(0, 1)}</span>
              <span style={{ fontSize: 9.5, color: "var(--fg-mid)", whiteSpace: "nowrap" }}>{name}</span>
            </div>
          ))}
        </div>
      ))}
      <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)" }}>主教练 · {side.coach}</div>
    </div>
  );

  const intelSide = (name: string, color: string, items: V[]) => (
    <Card style={{ padding: "10px 14px 6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
        <span style={{ fontSize: 12, fontWeight: 700 }}>{name} · {color === "var(--home)" ? "主队情报" : "客队情报"}</span>
      </div>
      {items.length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)", padding: "9px 0", borderTop: "1px solid var(--line-soft)" }}>暂无官方伤停通报</div>}
      {items.map((i: V, idx: number) => (
        <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--line-soft)" }}>
          <span style={{ flex: 1, fontSize: 12, color: "var(--fg-mid)" }}>{i.x}</span>
          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, color: i.tag === "缺阵" ? "var(--red)" : i.tag === "解禁" ? "#2ecc8a" : "var(--gold)" }}>{i.tag}</span>
        </div>
      ))}
    </Card>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flexShrink: 0, padding: "16px 22px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(h.leagueId) }} />
          <span style={{ fontSize: 11.5, color: "var(--fg-2)", fontWeight: 600, whiteSpace: "nowrap" }}>{h.league} · {h.round}</span>
          <span style={{ fontSize: 10, color: h.live ? "var(--red)" : "var(--fg-3)", fontWeight: 700, whiteSpace: "nowrap" }}>
            {h.live ? `${h.elapsed ?? ""}' 进行中` : h.finished ? "已完场" : `今日 ${hhmm(h.kickoff, tz)} 开赛`}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: "var(--fg-3)", whiteSpace: "nowrap" }}>⟳ {h.fresh.line}{v.summary.oddsAt ? ` · 盘口 ${Math.max(0, Math.round((Date.now() - v.summary.oddsAt) / 60_000))}m前` : ""}</span>
          {copied && <span style={{ fontSize: 9, color: "var(--up)", fontWeight: 700, whiteSpace: "nowrap" }}>链接已复制</span>}
          <span onClick={copyLink} style={{ cursor: "pointer", color: "var(--fg-2)", display: "flex", alignItems: "center", flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="10" r="2.4" /><circle cx="15" cy="4.5" r="2.4" /><circle cx="15" cy="15.5" r="2.4" />
              <path d="M7.2 8.9l5.6-3.2M7.2 11.1l5.6 3.2" />
            </svg>
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 22, fontWeight: 800, whiteSpace: "nowrap" }}>{h.home}</span>
            <span style={{ fontSize: 10, fontWeight: 800, color: "var(--home)" }}>主</span>
          </div>
          <span className="mono" style={{ fontSize: 24, fontWeight: 800, color: h.live || h.finished ? "var(--gold)" : "var(--fg-4)", whiteSpace: "nowrap" }}>
            <Flash v={h.live || h.finished ? (h.score ?? "VS") : "VS"} />
          </span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "var(--gold)" }}>客</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: "var(--fg-mid)", whiteSpace: "nowrap" }}>{h.away}</span>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 8 }}>
            {[
              ["亚盘", v.summary.ah?.text ?? "—", v.summary.ah?.w ?? ""],
              ["大小", v.summary.ou?.text ?? "—", v.summary.ou?.w ?? ""],
              ["胜平负", "", v.summary.eu?.w ?? "—"],
            ].map(([k, t, w]) => (
              <div key={k as string} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 14px", textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 2 }}>{k as string}</div>
                <div style={{ fontSize: 11, whiteSpace: "nowrap", display: "flex", justifyContent: "center", gap: 3 }}>
                  {t ? <Flash v={t as string} style={{ color: "var(--gold)", fontWeight: 700 }} /> : null}
                  <Flash v={w as string} className="mono" style={{ color: "var(--fg-mid)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidescroll" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
          {TAB_DEFS.map(([k, label]) => (
            <div key={k} onClick={() => setTab(k)} style={{ padding: "8px 13px 9px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, color: tab === k ? "var(--gold)" : "var(--fg-2)", borderBottom: `2px solid ${tab === k ? "var(--gold)" : "transparent"}`, marginBottom: -1 }}>
              {label}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 22px 20px" }}>
        {tab === "odds" && (
          <>
            {h.live && v.liveOdds && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--card)", border: "1px solid rgba(240,67,79,.3)", borderRadius: 10, padding: "10px 16px", marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />
                  <span className="mono" style={{ fontSize: 10, color: "var(--red)", fontWeight: 700, whiteSpace: "nowrap" }}>滚球 LIVE</span>
                </span>
                {v.liveOdds.map((r: V) => (
                  <span key={r.mk} style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 10, fontWeight: 800, borderRadius: 4, padding: "2px 7px", background: "var(--inset)", color: "var(--fg-2)", whiteSpace: "nowrap" }}>{r.mk}</span>
                    {r.susp && <span style={{ fontSize: 8.5, fontWeight: 800, color: "var(--fg-3)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>封盘中</span>}
                    <Flash v={r.v || "—"} className="mono" style={{ fontSize: 12, fontWeight: 700, color: r.susp ? "var(--fg-3)" : "var(--fg)", whiteSpace: "nowrap" }} />
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }}>
              {trendCol("亚盘水位走势", v.odds.ah, ["主水", "客水"])}
              {trendCol("大小球水位走势", v.odds.ou, ["大水", "小水"])}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px" }}>胜平负赔率走势</div>
                <Card style={{ padding: "10px 8px 4px" }}>
                  <LineChart rows={v.odds.euChart} id="eu" />
                </Card>
                <Card style={{ marginTop: 8, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "52px 1fr 1fr 1fr", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
                    {["时间", "主胜", "平局", "客胜"].map((c, i) => (
                      <span key={c} style={{ fontSize: 9, color: "var(--fg-3)", textAlign: i > 0 ? "right" : "left" }}>{c}</span>
                    ))}
                  </div>
                  {v.odds.eu.map((r: V, i: number) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "52px 1fr 1fr 1fr", padding: "6px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{r.t}</span>
                      <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{r.h}</span>
                      <span className="mono" style={{ fontSize: 11, textAlign: "right", color: "var(--fg-2)" }}>{r.d}</span>
                      <span className="mono" style={{ fontSize: 11, textAlign: "right" }}>{r.a}</span>
                    </div>
                  ))}
                </Card>
              </div>
            </div>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", padding: "12px 0 0" }}>
              {[["var(--home)", "主队 / 大球 / 主胜"], ["var(--gold)", "客队 / 小球 / 客胜"], ["var(--fg-2)", "平局"]].map(([c, l]) => (
                <span key={l} style={{ fontSize: 10, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 10, height: 2, background: c, borderRadius: 2 }} />{l}
                </span>
              ))}
            </div>
          </>
        )}

        {tab === "comp" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }}>
              {compCol("亚盘 · 多公司", v.comp.ah)}
              {compCol("大小球 · 多公司", v.comp.ou)}
              {compCol("胜平负 · 多公司", v.comp.eu, true)}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "10px 2px 0" }}>上行为初盘,下行为即时盘;各公司变盘时间与幅度可横向比对。</div>
          </>
        )}

        {tab === "tech" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
            <Card style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>近况 · 最近 6 场</div>
              {[[h.home, v.tech.formHome, false], [h.away, v.tech.formAway, true]].map(([name, form, away]) => (
                <div key={String(name)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: away ? 0 : 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: away ? "var(--fg-mid)" : undefined }}>{name as string}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {(form as string[]).length === 0 && <span style={{ fontSize: 10, color: "var(--fg-3)" }}>数据积累中</span>}
                    {(form as string[]).map((ch, i) => {
                      const s = FORM_STYLE[ch] ?? FORM_STYLE.平;
                      return <span key={i} style={{ width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, background: s.bg, color: s.c }}>{ch}</span>;
                    })}
                  </div>
                </div>
              ))}
              {h.live && v.tech.half && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 12, paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>半场拆分 · 上半场</div>
                  {v.tech.half.map((b: V) => (
                    <div key={b.label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                      <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                      <span style={{ fontSize: 9.5, color: "var(--fg-2)" }}>{b.label}</span>
                      <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--gold)" }}>{b.rv}</span>
                    </div>
                  ))}
                </div>
              )}
              {h.live && v.tech.stats && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 12, paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>实时技术统计</div>
                  {v.tech.stats.map((b: V) => (
                    <div key={b.label} style={{ marginBottom: 9 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                        <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{b.label}</span>
                        <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "var(--gold)" }}>{b.rv}</span>
                      </div>
                      <div style={{ display: "flex", gap: 3, height: 4 }}>
                        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--home)", width: `${(b.l / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                        <div style={{ flex: 1, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--gold)", width: `${(b.r / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>进球时段分布</div>
              {!v.tech.minutes && <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>数据积累中</div>}
              {v.tech.minutes?.rows.map((r: V) => (
                <div key={r.label} style={{ display: "grid", gridTemplateColumns: "40px 1fr 34px", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{r.label}</span>
                  <span style={{ display: "block" }}>
                    <span style={{ display: "block", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden", marginBottom: 2 }}>
                      <span style={{ display: "block", height: "100%", background: "var(--home)", width: `${Math.min(100, r.h * 3)}%` }} />
                    </span>
                    <span style={{ display: "block", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", background: "var(--gold)", width: `${Math.min(100, r.a * 3)}%` }} />
                    </span>
                  </span>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-2)", textAlign: "right" }}>{r.h}/{r.a}</span>
                </div>
              ))}
              {v.tech.minutes && <div style={{ fontSize: 9.5, color: "var(--fg-3)", marginTop: 4 }}>{v.tech.minutes.note}</div>}
              {h.live && v.tech.events && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 10, paddingTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>实时事件</div>
                  {v.tech.events.slice(0, 8).map((e: V, i: number) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span className="mono" style={{ width: 32, fontSize: 10, color: "var(--fg-2)" }}>{e.m}</span>
                      <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)" }}>{e.x}</span>
                      <span style={{ fontSize: 9.5, fontWeight: 700, color: e.s === "主" ? "var(--home)" : "var(--gold)" }}>{e.s}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card style={{ padding: "12px 14px", alignSelf: "start" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>历史交锋</div>
              {v.tech.h2h.length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)" }}>暂无交锋记录</div>}
              {v.tech.h2h.map((r: V, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "56px 1fr 44px 40px 26px", padding: "6px 0", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{r.d}</span>
                  <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{r.c}</span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 700, textAlign: "center" }}>{r.s}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, textAlign: "center", color: r.res === "胜" ? "var(--up)" : r.res === "负" ? "var(--down)" : "var(--fg-2)" }}>{r.res}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, textAlign: "center", color: r.ou === "大" ? "var(--gold)" : "var(--home)" }}>{r.ou}</span>
                </div>
              ))}
              {v.tech.standings.length > 0 && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 10, paddingTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>联赛排名</div>
                  {v.tech.standings.map((r: V) => (
                    <div key={r.team} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span className="mono" style={{ width: 22, height: 22, borderRadius: 6, background: "var(--inset)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "var(--gold)" }}>{r.rk}</span>
                      <span style={{ flex: 1 }}>
                        <span style={{ display: "block", fontSize: 11.5, fontWeight: 700 }}>{r.team}</span>
                        <span style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{r.ha}</span>
                      </span>
                      <span style={{ textAlign: "right" }}>
                        <span className="mono" style={{ display: "block", fontSize: 10.5, color: "var(--fg-2)" }}>{r.rec}</span>
                        <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{r.gd} · {r.pts}分</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === "report" &&
          (report ? (
            report.locked ? (
              <div style={{ background: "linear-gradient(180deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.35)", borderRadius: 14, padding: 28, maxWidth: 520, margin: "24px auto 0", textAlign: "center" }}>
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--gold)" strokeWidth="1.4" strokeLinecap="round" style={{ marginBottom: 8 }}>
                  <rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                </svg>
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 5 }}>AI 分析报告已锁定</div>
                <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.7, marginBottom: 14 }}>
                  包含盘口解读、状态盘路、进球模型、人员情报与结论
                  <br />
                  解锁本场预测后即可阅读全文
                </div>
                <div
                  onClick={() => (loggedIn ? requestUnlock({ id: report.id, match: report.match, price: report.price }) : router.push("/login"))}
                  style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 10, padding: "11px 0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
                >
                  {loggedIn ? `${report.price} 积分 · 解锁本场预测` : "注册领 58 积分 · 免费解锁 1 场"}
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 7px", flexShrink: 0 }}>结论</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)" }}>{report.advice}</span>
                  <span style={{ flex: 1 }} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
                  {report.sections.map((sec: V) => (
                    <Card key={sec.h} style={{ borderRadius: 12, padding: "13px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--gold)" }} />
                        <span style={{ fontSize: 12.5, fontWeight: 800 }}>{sec.h}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {sec.ps.map((x: string, i: number) => (
                          <div key={i} style={{ fontSize: 11.5, color: "var(--fg-mid)", lineHeight: 1.8 }}>{x}</div>
                        ))}
                      </div>
                    </Card>
                  ))}
                </div>
                <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-4)", padding: "12px 0 0" }}>报告由 AI 基于本场赛前数据自动生成 · 仅供参考,不构成投注建议</div>
              </>
            )
          ) : (
            <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0" }}>报告加载中…</div>
          ))}

        {tab === "lineup" &&
          (v.lineups.ready ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px" }}>
                  <span style={{ color: "var(--home)" }}>{h.home}</span> · <span className="mono" style={{ color: "var(--fg-2)" }}>{v.lineups.home.form}</span>
                </div>
                {pitch(v.lineups.home, "var(--home)")}
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px" }}>
                  <span style={{ color: "var(--gold)" }}>{h.away}</span> · <span className="mono" style={{ color: "var(--fg-2)" }}>{v.lineups.away.form}</span>
                </div>
                {pitch(v.lineups.away, "var(--gold)")}
              </div>
            </div>
          ) : (
            <div style={{ background: "var(--card)", border: "1px dashed #272d3a", borderRadius: 12, padding: "44px 20px", textAlign: "center", maxWidth: 560, margin: "20px auto 0" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-2)" }}>官方首发尚未公布</div>
              <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.7 }}>通常于开赛前约 40 分钟公布,公布后自动更新</div>
            </div>
          ))}

        {tab === "intel" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
              {intelSide(h.home, "var(--home)", v.intel.filter((i: V) => i.side === "主"))}
              {intelSide(h.away, "var(--gold)", v.intel.filter((i: V) => i.side === "客"))}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "10px 2px 0" }}>缺阵 / 存疑 / 解禁 状态随官方发布实时更新;首发公布前请结合阵容页交叉确认。</div>
          </>
        )}

        {tab === "deep" &&
          (deepV ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Card style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>球场因素</span>
                    <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{deepV.venue?.city}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{deepV.venue?.name}<span style={{ fontSize: 10, color: "var(--fg-2)", fontWeight: 400, marginLeft: 10 }}>当值主裁:{deepV.referee ?? "未公布"}</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[[deepV.venue?.cap, "容量"], [deepV.venue?.surface, "草皮"], [deepV.venue?.country || "—", "国家/地区"]].map(([val, label]) => (
                      <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 0", textAlign: "center" }}>
                        <div className="mono" style={{ fontSize: 12, fontWeight: 800 }}>{val as string}</div>
                        <div style={{ fontSize: 8.5, color: "var(--fg-3)" }}>{label as string}</div>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>射手依赖度</div>
                  {(deepV.scorers ?? []).length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)", padding: "7px 0" }}>榜单数据积累中</div>}
                  {deepV.scorers?.map((s: V) => (
                    <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: s.side === "h" ? "var(--home)" : "var(--gold)" }} />
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{s.name}</span>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{s.goals} 球</span>
                      {s.share != null && (
                        <span style={{ width: 90 }}>
                          <span style={{ display: "block", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden", marginBottom: 2 }}>
                            <span style={{ display: "block", height: "100%", background: "linear-gradient(90deg,#8a6a1f,var(--gold))", width: `${s.share}%` }} />
                          </span>
                          <span style={{ fontSize: 8.5, color: "var(--fg-2)" }}>
                            占全队 <span className="mono" style={{ color: "var(--gold)", fontWeight: 700 }}>{s.share}%</span>
                          </span>
                        </span>
                      )}
                    </div>
                  ))}
                  <div style={{ height: 6 }} />
                </Card>
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>教练 · 转会</div>
                  {deepV.coaches?.map((c: V) => (
                    <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: c.side === "h" ? "var(--home)" : "var(--gold)" }} />
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{c.name}</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-2)" }}>{c.meta}</span>
                    </div>
                  ))}
                  {deepV.transfers?.map((t: V) => (
                    <div key={t.team} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "2px 6px", background: "var(--inset)", color: t.tag === "转入" ? "#2ecc8a" : t.tag === "转出" ? "#f0434f" : "#959ba6" }}>{t.tag}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{t.team}</span>
                      <span style={{ fontSize: 10.5, color: "var(--fg-2)" }}>{t.x}</span>
                    </div>
                  ))}
                  <div style={{ height: 6 }} />
                </Card>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>联赛榜单</div>
                  {deepV.lb?.map((r: V) => (
                    <div key={r.tag} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ flexShrink: 0, width: 44, fontSize: 10, fontWeight: 800, borderRadius: 4, padding: "2px 0", textAlign: "center", background: "var(--inset)", color: r.tagC }}>{r.tag}</span>
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.v}</span>
                    </div>
                  ))}
                  <div style={{ height: 6 }} />
                </Card>
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>赛季场均评分 · 关键球员</div>
                  {(deepV.ratings ?? []).length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)", padding: "7px 0" }}>评分数据积累中</div>}
                  {deepV.ratings?.map((r: V) => {
                    const bc = r.r >= 8 ? ["rgba(233,185,73,.16)", "#e9b949"] : r.r >= 7 ? ["rgba(46,204,138,.16)", "#2ecc8a"] : ["rgba(149,155,166,.16)", "#959ba6"];
                    return (
                      <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: r.side === "h" ? "var(--home)" : "var(--gold)" }} />
                        <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                        <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "2px 6px" }}>{r.pos}</span>
                        <span className="mono" style={{ width: 34, textAlign: "center", fontSize: 11, fontWeight: 800, borderRadius: 5, padding: "3px 0", background: bc[0], color: bc[1] }}>{r.r.toFixed(1)}</span>
                      </div>
                    );
                  })}
                  <div style={{ height: 6 }} />
                </Card>
                <Card style={{ padding: "10px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>教练荣誉</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {(deepV.motiv ?? []).length === 0 && <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>数据积累中</span>}
                    {deepV.motiv?.map((x: string) => (
                      <div key={x} style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6 }}>
                        <span style={{ color: "var(--gold)" }}>·</span>
                        <span>{x}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0" }}>深挖数据加载中…</div>
          ))}
      </div>
    </div>
  );
}
