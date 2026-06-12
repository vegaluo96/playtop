"use client";

/** 桌面中栏:比赛头 + tab(指数走势/对比/技术面/AI报告/阵容/情报/深挖) */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { type ChartRow } from "@/components/charts";
import { IndexChart } from "@/components/index-chart";
import { PlayerAvatar, TeamLogo } from "@/components/img";
import { PlayerSheet, type PlayerTarget } from "@/components/player-sheet";
import { MatchTimeline, WeatherCard } from "@/components/match-timeline";
import { CompMetaBar, CornersRefNote, FatigueCard, RoadSection, SameOddsCard } from "@/components/insights";
import { QuoteHistorySheet, type HistoryTarget } from "@/components/quote-history";
import { useWatchlist, WatchStar } from "@/components/watch";
import { Flash } from "@/components/live";
import { MarketCell, MarketValue, type MarketCellData } from "@/components/market-cell";
import { ahText, dayLabel, hhmm } from "@/lib/format";
import { leagueColor } from "@/lib/leagues";
import type { DTab } from "./terminal";
import { SITE_HOST } from "@/lib/site";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

function pairSummary(s: V | null | undefined): MarketCellData | null {
  if (!s?.w) return null;
  const [h, a] = String(s.w).split("/").map(Number);
  return Number.isFinite(h) && Number.isFinite(a) ? { text: s.text, h, a, chgAt: s.chgAt } : null;
}

function euSummary(s: V | null | undefined): MarketCellData | null {
  if (!s?.w) return null;
  const [h, d, a] = String(s.w).split("/").map(Number);
  return [h, d, a].every(Number.isFinite) ? { h, d, a, chgAt: s.chgAt } : null;
}

const TAB_DEFS: [DTab, string][] = [
  ["odds", "指数"], ["match", "赛况"], ["squad", "人员"], ["deep", "深度"], ["report", "AI 报告"],
];
const ODDS_SUBS: [string, string][] = [["trend", "走势"], ["comp", "对比"], ["road", "盘路"], ["markets", "更多玩法"]];

const FORM_STYLE: Record<string, { bg: string; c: string }> = {
  胜: { bg: "rgba(46,204,138,.16)", c: "var(--green)" },
  平: { bg: "rgba(139,148,168,.16)", c: "var(--fg-3)" },
  负: { bg: "rgba(255,92,92,.16)", c: "var(--red)" },
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
  const [player, setPlayer] = useState<PlayerTarget | null>(null);
  const [history, setHistory] = useState<HistoryTarget | null>(null);
  const [oddsSub, setOddsSub] = useState("trend");
  const watch = useWatchlist(loggedIn);
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

  const trendCol = (title: string, data: { rows: V[]; chart: ChartRow[] }, idx: V, mk: "ah" | "ou", cols: [string, string]) => (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        {title}
        {data.chart.length > 1 && <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 500 }}>自 {data.chart[0].t} 归档</span>}
      </div>
      <Card style={{ padding: "10px 10px 6px" }}>
        <IndexChart
          data={idx}
          kickoff={h.kickoff}
          tz={tz}
          unit={mk === "ah" ? "主水指数" : "大球指数"}
          lineText={(l) => (l == null ? "" : mk === "ah" ? ahText(l) : `${l} 球`)}
          height={150}
        />
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.5 }}>{idx?.method}</div>
      </Card>
      <Card style={{ marginTop: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 44px 44px", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
          {["时间", "指数", cols[0], cols[1]].map((c, i) => (
            <span key={c} style={{ fontSize: 11.5, color: "var(--fg-3)", textAlign: i >= 2 ? "right" : "left" }}>{c}</span>
          ))}
        </div>
        {data.rows.length === 0 && <div style={{ padding: 12, fontSize: 11.5, color: "var(--fg-3)", textAlign: "center" }}>快照积累中</div>}
        {data.rows.map((r: V, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "72px 1fr 50px 50px", padding: "7px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{r.t}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
              <MarketValue v={r.text} className="" small style={{ color: r.chg ? "var(--gold)" : "var(--fg-mid)", fontWeight: 800 }} />
              {r.chg ? <span style={{ fontSize: 11.5, fontWeight: 800, color: "var(--gold)" }}>变盘</span> : null}
            </span>
            <MarketValue v={r.h} small style={{ justifyContent: "flex-end" }} />
            <MarketValue v={r.a} small style={{ justifyContent: "flex-end" }} />
          </div>
        ))}
        <div onClick={() => setHistory({ id: h.id, mk })} style={{ padding: "9px 0", textAlign: "center", fontSize: 11.5, fontWeight: 800, color: "var(--gold)", cursor: "pointer" }}>
          完整历史报价 ›
        </div>
      </Card>
    </div>
  );

  const compCol = (title: string, rows: V[], mk: "ah" | "ou" | "eu") => {
    const eu = mk === "eu";
    return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        {title}
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 500 }}>点击公司看历史</span>
      </div>
      <Card style={{ overflow: "hidden" }}>
        {rows.length === 0 && <div style={{ padding: 12, fontSize: 11.5, color: "var(--fg-3)", textAlign: "center" }}>暂无官方指数数据</div>}
        {rows.map((c: V) => (
          <div key={c.co} onClick={() => c.bid && setHistory({ id: h.id, mk, bid: c.bid, co: c.co })} style={{ display: "grid", gridTemplateColumns: eu ? "68px 1fr" : "68px 1fr 1fr", padding: "9px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)", cursor: c.bid ? "pointer" : "default" }}>
            <span style={{ fontSize: 12, fontWeight: 800 }}>{c.co}</span>
            {eu ? (
              <span>
                <MarketValue v={c.iW} small dim style={{ justifyContent: "flex-start" }} />
                <MarketValue v={c.nW} small pulse={c.changed ? c.chgAt : null} style={{ justifyContent: "flex-start", color: c.changed ? "var(--gold)" : "var(--fg-mid)" }} />
              </span>
            ) : (
              <>
                <span>
                  <MarketValue v={c.iText} className="" small dim style={{ justifyContent: "flex-start" }} />
                  <MarketValue v={c.iW} small dim style={{ justifyContent: "flex-start" }} />
                </span>
                <span>
                  <MarketValue v={c.nText} className="" small pulse={c.changed ? c.chgAt : null} style={{ justifyContent: "flex-start", color: c.changed ? "var(--gold)" : "var(--fg-mid)", fontWeight: 800 }} />
                  <MarketValue v={c.nW} small pulse={c.waterChanged || c.changed ? c.chgAt : null} style={{ justifyContent: "flex-start", color: c.waterChanged || c.changed ? "var(--gold)" : "var(--fg-mid)" }} />
                </span>
              </>
            )}
          </div>
        ))}
      </Card>
    </div>
    );
  };

  const pitch = (side: V, color: string) => (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "16px 8px", display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 320, height: "100%", boxSizing: "border-box" }}>
      {side.rows.map((row: V[], i: number) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-evenly" }}>
          {row.map((p: V) => (
            <div key={p.n} onClick={() => p.id && setPlayer({ id: p.id, name: p.n, season: h.season })} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 64, cursor: p.id ? "pointer" : "default" }}>
              <PlayerAvatar id={p.id} name={p.n} num={p.num} size={28} ring={color} />
              <span style={{ fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap" }}>{p.n}</span>
            </div>
          ))}
        </div>
      ))}
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>主教练 · {side.coach}</div>
      {side.subs?.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line-soft)" }}>
          <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 5 }}>替补席</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {side.subs.map((p: V) => (
              <span key={p.n} className="mono" style={{ fontSize: 11, color: "var(--fg-mid)", background: "var(--inset)", borderRadius: 5, padding: "2px 7px" }}>
                {p.num != null ? `${p.num} ` : ""}{p.n}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const intelSide = (name: string, color: string, items: V[]) => (
    <Card style={{ padding: "10px 14px 6px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
        <span style={{ fontSize: 12, fontWeight: 700 }}>{name} · {color === "var(--home)" ? "主队情报" : "客队情报"}</span>
      </div>
      {items.length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "9px 0", borderTop: "1px solid var(--line-soft)" }}>暂无官方伤停通报</div>}
      {items.map((i: V, idx: number) => (
        <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--line-soft)" }}>
          <span style={{ flex: 1, fontSize: 12, color: "var(--fg-mid)" }}>{i.x}</span>
          <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: i.tag === "缺阵" ? "var(--red)" : i.tag === "解禁" ? "var(--green)" : "var(--gold)" }}>{i.tag}</span>
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
          <span style={{ fontSize: 11, color: h.live ? "var(--red)" : "var(--fg-3)", fontWeight: 700, whiteSpace: "nowrap" }}>
            {h.live ? (h.ht ? "中场休息" : `${h.elapsed ?? ""}' 进行中`) : h.finished ? "已完场" : `${dayLabel(h.kickoff, tz)} ${hhmm(h.kickoff, tz)} 开赛`}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--fg-3)", whiteSpace: "nowrap" }}>{h.finished ? "已完场 · 数据已固化" : `⟳ ${h.fresh.freq}刷新`}{v.summary.oddsAt ? ` · 指数 ${Math.max(0, Math.round((Date.now() - v.summary.oddsAt) / 60_000))}m前` : ""}</span>
          <WatchStar on={watch.ids.has(h.id)} onToggle={() => watch.toggle(h.id)} size={14} />
          {copied && <span style={{ fontSize: 11, color: "var(--up)", fontWeight: 700, whiteSpace: "nowrap" }}>链接已复制</span>}
          <span onClick={copyLink} style={{ cursor: "pointer", color: "var(--fg-2)", display: "flex", alignItems: "center", flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="10" r="2.4" /><circle cx="15" cy="4.5" r="2.4" /><circle cx="15" cy="15.5" r="2.4" />
              <path d="M7.2 8.9l5.6-3.2M7.2 11.1l5.6 3.2" />
            </svg>
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 22, fontWeight: 800, whiteSpace: "nowrap" }}>{h.home}</span>
            <TeamLogo id={h.homeId} name={h.home} size={26} />
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--home)" }}>主</span>
          </div>
          <span className="mono" style={{ fontSize: 24, fontWeight: 800, color: h.live || h.finished ? "var(--gold)" : "var(--fg-4)", whiteSpace: "nowrap" }}>
            <Flash v={h.live || h.finished ? (h.score ?? "VS") : "VS"} />
          </span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--team-away)" }}>客</span>
            <TeamLogo id={h.awayId} name={h.away} size={26} /><span style={{ fontSize: 22, fontWeight: 800, color: "var(--fg-mid)", whiteSpace: "nowrap" }}>{h.away}</span>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { label: "让球", kind: "ah" as const, cell: pairSummary(v.summary.ah) },
              { label: "大小", kind: "ou" as const, cell: pairSummary(v.summary.ou) },
              { label: "胜平负", kind: "eu" as const, cell: euSummary(v.summary.eu) },
            ].map(({ label, kind, cell }) => (
              <div key={label} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 14px", textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 2 }}>{label}</div>
                <MarketCell kind={kind} cell={cell} style={{ background: "transparent", padding: 0 }} />
              </div>
            ))}
          </div>
        </div>
        <div className="hidescroll" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", overflowX: "auto" }}>
          {TAB_DEFS.map(([k, label]) => (
            <div key={k} onClick={() => setTab(k)} style={{ position: "relative", padding: "8px 13px 9px", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, color: tab === k ? "var(--gold)" : "var(--fg-2)", borderBottom: `2px solid ${tab === k ? "var(--gold)" : "transparent"}`, marginBottom: -1 }}>
              {label}
              {k === "match" && h.live && <span className="livepulse" style={{ position: "absolute", top: 7, right: 4, width: 4, height: 4, borderRadius: "50%", background: "var(--red)" }} />}
            </div>
          ))}
          {tab === "odds" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 12 }}>
              {ODDS_SUBS.map(([k, label]) => (
                <span key={k} onClick={() => setOddsSub(k)} style={{ fontSize: 11.5, fontWeight: 700, cursor: "pointer", borderRadius: 7, padding: "3px 10px", background: oddsSub === k ? "var(--selected-bg)" : "var(--inset)", color: oddsSub === k ? "var(--gold)" : "var(--fg-3)" }}>
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 22px 20px" }}>
        {tab === "odds" && oddsSub === "trend" && (
          <>
            {h.live && v.liveOdds && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, background: "var(--card)", border: "1px solid rgba(255,92,92,.3)", borderRadius: 10, padding: "10px 16px", marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--red)", fontWeight: 800, whiteSpace: "nowrap" }}>滚球 LIVE</span>
                </span>
                {v.liveOdds.map((r: V) => (
                  <span key={r.mk} style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, borderRadius: 4, padding: "2px 7px", background: "var(--inset)", color: "var(--fg-2)", whiteSpace: "nowrap" }}>{r.mk}</span>
                    {r.susp && <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-3)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>封盘中</span>}
                    <MarketValue v={r.v || "—"} small dim={!!r.susp} style={{ justifyContent: "flex-start", color: r.susp ? "var(--fg-3)" : "var(--fg)" }} />
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }}>
              {trendCol("让球指数走势", v.odds.ah, v.odds.index?.ah, "ah", ["主水", "客水"])}
              {trendCol("大小指数走势", v.odds.ou, v.odds.index?.ou, "ou", ["大水", "小水"])}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, margin: "0 2px 8px" }}>胜平负指数走势</div>
                <Card style={{ padding: "10px 10px 6px" }}>
                  <IndexChart data={v.odds.index?.eu} kickoff={h.kickoff} tz={tz} unit="主胜概率" height={150} />
                  <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4, lineHeight: 1.5 }}>{v.odds.index?.eu?.method}</div>
                </Card>
                <Card style={{ marginTop: 8, overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "76px 1fr 1fr 1fr", padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
                    {["时间", "主胜", "平局", "客胜"].map((c, i) => (
                      <span key={c} style={{ fontSize: 11.5, color: "var(--fg-3)", textAlign: i > 0 ? "right" : "left" }}>{c}</span>
                    ))}
                  </div>
                  {v.odds.eu.map((r: V, i: number) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "76px 1fr 1fr 1fr", padding: "7px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                      <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{r.t}</span>
                      <MarketValue v={r.h} small style={{ justifyContent: "flex-end" }} />
                      <MarketValue v={r.d} small dim style={{ justifyContent: "flex-end" }} />
                      <MarketValue v={r.a} small style={{ justifyContent: "flex-end" }} />
                    </div>
                  ))}
                  <div onClick={() => setHistory({ id: h.id, mk: "eu" })} style={{ padding: "8px 0", textAlign: "center", fontSize: 11.5, fontWeight: 700, color: "var(--gold)", cursor: "pointer" }}>
                    完整历史报价 ›
                  </div>
                </Card>
              </div>
            </div>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", padding: "12px 0 0" }}>
              {[["var(--home)", "主队 / 大球 / 主胜"], ["var(--team-away)", "客队 / 小球 / 客胜"], ["var(--fg-2)", "平局"]].map(([c, l]) => (
                <span key={l} style={{ fontSize: 11, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 10, height: 2, background: c, borderRadius: 2 }} />{l}
                </span>
              ))}
            </div>
          </>
        )}

        {tab === "odds" && oddsSub === "comp" && (
          <>
            <CompMetaBar comp={v.comp} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }}>
              {compCol("让球指数 · 对比", v.comp.ah, "ah")}
              {compCol("大小指数 · 对比", v.comp.ou, "ou")}
              {compCol("胜平负指数 · 对比", v.comp.eu, "eu")}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "10px 2px 0" }}>上行为初盘(开赛前 14 天起本站持续归档的最早指数),下行为即时盘;各公司变盘时间与幅度可横向比对。</div>
          </>
        )}

        {tab === "odds" && oddsSub === "road" && (
          <>
            <RoadSection ins={v.insights} home={h.home} away={h.away} />
            <SameOddsCard so={v.insights?.sameOdds} />
            <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "10px 2px 0" }}>{v.insights?.note}</div>
          </>
        )}

        {tab === "odds" && oddsSub === "markets" && (
          <>
            {(v.markets ?? []).length === 0 && <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)", padding: "40px 0" }}>暂无扩展玩法数据,开盘后自动解析半场盘/角球/罚牌/波胆等</div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
              {(v.markets ?? []).map((m: V) => (
                <Card key={m.key} style={{ padding: "10px 14px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 800 }}>{m.name}</span>
                    <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{m.bk}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: m.key === "exact" || m.key === "htft" ? "1fr 1fr 1fr" : "1fr 1fr", gap: 6 }}>
                    {m.rows.map((r: V, i: number) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "7px 10px" }}>
                        <span style={{ fontSize: 11.5, color: "var(--fg-2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.v}</span>
                        <MarketValue v={r.odd} small style={{ color: "var(--gold)", justifyContent: "flex-end", fontWeight: 800 }} />
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <CornersRefNote cr={v.insights?.cornersRef} home={h.home} away={h.away} />
            </div>
            {(v.markets ?? []).length > 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "10px 2px 0" }}>玩法指数为胜平负原值,来自单一公司当帧报价;仅供数据参考。</div>}
          </>
        )}

        {tab === "match" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 }}>
            {v.tech.timeline ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, alignSelf: "start" }}>
                <MatchTimeline tl={v.tech.timeline} home={h.home} away={h.away} live={h.live} />
                <WeatherCard w={v.weather} />
                {!h.finished && <FatigueCard fa={v.insights?.fatigue} home={h.home} away={h.away} />}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, alignSelf: "start" }}>
                <WeatherCard w={v.weather} />
                <FatigueCard fa={v.insights?.fatigue} home={h.home} away={h.away} />
              </div>
            )}
            <Card style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>近况 · 最近 6 场</div>
              {[[h.home, v.tech.formHome, false], [h.away, v.tech.formAway, true]].map(([name, form, away]) => (
                <div key={String(name)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: away ? 0 : 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: away ? "var(--fg-mid)" : undefined }}>{name as string}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {(form as string[]).length === 0 && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>近期战绩暂无官方数据</span>}
                    {(form as string[]).map((ch, i) => {
                      const s = FORM_STYLE[ch] ?? FORM_STYLE.平;
                      return <span key={i} style={{ width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, background: s.bg, color: s.c }}>{ch}</span>;
                    })}
                  </div>
                </div>
              ))}
              {h.live && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 12, paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>半场拆分 · 上半场</div>
                  {!v.tech.half && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "6px 0" }}>暂无半场拆分数据</div>}
                  {(v.tech.half ?? []).map((b: V) => (
                    <div key={b.label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                      <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                      <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{b.label}</span>
                      <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--gold)" }}>{b.rv}</span>
                    </div>
                  ))}
                </div>
              )}
              {h.live && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 12, paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>实时技术统计</div>
                  {!v.tech.stats && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "6px 0" }}>暂无技术统计,随官方接口实时更新</div>}
                  {(v.tech.stats ?? []).map((b: V) => (
                    <div key={b.label} style={{ marginBottom: 9 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                        <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{b.label}</span>
                        <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: "var(--team-away)" }}>{b.rv}</span>
                      </div>
                      <div style={{ display: "flex", gap: 3, height: 4 }}>
                        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--home)", width: `${(b.l / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                        <div style={{ flex: 1, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--team-away)", width: `${(b.r / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>进球时段分布</div>
              {!v.tech.minutes && <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>暂无官方进球时段数据</div>}
              {v.tech.minutes?.rows.map((r: V) => (
                <div key={r.label} style={{ display: "grid", gridTemplateColumns: "40px 1fr 34px", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{r.label}</span>
                  <span style={{ display: "block" }}>
                    <span style={{ display: "block", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden", marginBottom: 2 }}>
                      <span style={{ display: "block", height: "100%", background: "var(--home)", width: `${Math.min(100, r.h * 3)}%` }} />
                    </span>
                    <span style={{ display: "block", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", background: "var(--team-away)", width: `${Math.min(100, r.a * 3)}%` }} />
                    </span>
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right" }}>{r.h}/{r.a}</span>
                </div>
              ))}
              {v.tech.minutes && <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>{v.tech.minutes.note}</div>}
            </Card>
            <Card style={{ padding: "12px 14px", alignSelf: "start" }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>历史交锋</div>
              {v.tech.h2h.length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>暂无交锋记录</div>}
              {v.tech.h2h.map((r: V, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "56px 1fr 44px 40px 26px", padding: "6px 0", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{r.d}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.c}</span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 700, textAlign: "center" }}>{r.s}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, textAlign: "center", color: r.res === "胜" ? "var(--up)" : r.res === "负" ? "var(--down)" : "var(--fg-2)" }}>{r.res}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, textAlign: "center", color: r.ou === "大" ? "var(--gold)" : "var(--home)" }}>{r.ou}</span>
                </div>
              ))}
              {(v.tech.standings?.table ?? []).length > 0 && (
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 10, paddingTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>积分榜 <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 400 }}>官方返回 · 两队高亮</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 26px 56px 32px 32px", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                    {["#", "球队", "赛", "胜/平/负", "净胜", "分"].map((hd, i) => (
                      <span key={hd} style={{ fontSize: 11, color: "var(--fg-3)", textAlign: i >= 2 ? "center" : "left" }}>{hd}</span>
                    ))}
                  </div>
                  {v.tech.standings.table.map((r: V) => (
                    <div key={`${r.grp}-${r.rk}-${r.team}`} style={{ display: "grid", gridTemplateColumns: "24px 1fr 26px 56px 32px 32px", padding: "5px 0", alignItems: "center", borderBottom: "1px solid var(--line-soft)", background: r.hl ? "var(--selected-bg-soft)" : "transparent" }}>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: r.hl ? "var(--gold)" : "var(--fg-3)" }}>{r.rk}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                        <TeamLogo id={r.teamId} name={r.team} size={13} />
                        <span style={{ fontSize: 11.5, fontWeight: r.hl ? 800 : 600, color: r.hl ? (r.hl === "h" ? "var(--home)" : "var(--team-away)") : "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.team}</span>
                      </span>
                      <span className="mono" style={{ fontSize: 11, textAlign: "center", color: "var(--fg-2)" }}>{r.p}</span>
                      <span className="mono" style={{ fontSize: 11, textAlign: "center", color: "var(--fg-2)" }}>{r.w}/{r.dr}/{r.l}</span>
                      <span className="mono" style={{ fontSize: 11, textAlign: "center", color: r.gd > 0 ? "var(--up)" : r.gd < 0 ? "var(--down)" : "var(--fg-2)" }}>{r.gd > 0 ? `+${r.gd}` : r.gd}</span>
                      <span className="mono" style={{ fontSize: 11.5, fontWeight: 800, textAlign: "center", color: "var(--gold)" }}>{r.pts}</span>
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
              <div style={{ background: "var(--card)", border: "1px solid var(--selected-border)", borderRadius: 14, padding: 28, maxWidth: 520, margin: "24px auto 0", textAlign: "center" }}>
                <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="var(--gold)" strokeWidth="1.4" strokeLinecap="round" style={{ marginBottom: 8 }}>
                  <rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                </svg>
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 5 }}>AI 概率报告已锁定</div>
                <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.7, marginBottom: 14 }}>
                  指数解读、盘路状态、进球模型与人员情报
                </div>
                <div
                  onClick={() => (loggedIn ? requestUnlock({ id: report.id, match: report.match, price: report.price }) : router.push("/login"))}
                  style={{ background: "var(--cta)", color: "var(--on-cta)", borderRadius: 10, padding: "11px 0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
                >
                  {loggedIn ? `${report.price} 额度 · 解锁本场报告` : "登录查看报告额度说明"}
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px", marginBottom: 14 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 7px", flexShrink: 0 }}>摘要</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)" }}>{report.advice}</span>
                  <span style={{ flex: 1 }} />
                  {(report.versions ?? []).length > 0 && (
                    <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                      <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{report.lockedFinal ? "已开赛锁定" : "随指数更新"}</span>
                      {report.versions.map((vv: V) => (
                        <span
                          key={vv.ver}
                          onClick={() => void fetch(`/api/report/${fid}?tz=${encodeURIComponent(tz)}&v=${vv.ver}`, { cache: "no-store" }).then((r) => r.json()).then((j) => j.ok && setReport(j))}
                          className="mono"
                          style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 5, padding: "1px 7px", background: report.ver === vv.ver ? "var(--selected-bg-strong)" : "var(--card)", color: report.ver === vv.ver ? "var(--gold)" : "var(--fg-2)" }}
                        >
                          v{vv.ver}
                        </span>
                      ))}
                    </span>
                  )}
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
                <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)", padding: "12px 0 0" }}>报告按数据快照生成 · 概率视角仅供研究</div>
              </>
            )
          ) : (
            <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0" }}>报告加载中…</div>
          ))}

        {tab === "squad" &&
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
                  <span style={{ color: "var(--team-away)" }}>{h.away}</span> · <span className="mono" style={{ color: "var(--fg-2)" }}>{v.lineups.away.form}</span>
                </div>
                {pitch(v.lineups.away, "var(--team-away)")}
              </div>
            </div>
          ) : (
            <div style={{ background: "var(--card)", border: "1px dashed #272d3a", borderRadius: 12, padding: "44px 20px", textAlign: "center", maxWidth: 560, margin: "20px auto 0" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-2)" }}>官方首发尚未公布</div>
              <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.7 }}>通常于开赛前约 40 分钟公布,公布后自动更新</div>
            </div>
          ))}

        {tab === "squad" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
              {intelSide(h.home, "var(--home)", v.intel.filter((i: V) => i.side === "主"))}
              {intelSide(h.away, "var(--team-away)", v.intel.filter((i: V) => i.side === "客"))}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "10px 2px 0" }}>缺阵 / 存疑 / 解禁 状态随官方发布实时更新;首发公布前请结合阵容页交叉确认。</div>
          </>
        )}

        {tab === "deep" &&
          (deepV ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {deepV.venue?.name && deepV.venue.name !== "—" && (
                <Card style={{ padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>球场因素</span>
                    <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{deepV.venue?.city}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{deepV.venue?.name}<span style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 400, marginLeft: 10 }}>当值主裁:{deepV.referee ?? "未公布"}</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {[[deepV.venue?.cap, "容量"], [deepV.venue?.surface, "草皮"], [deepV.venue?.country || "—", "国家/地区"]].map(([val, label]) => (
                      <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 0", textAlign: "center" }}>
                        <div className="mono" style={{ fontSize: 12, fontWeight: 800 }}>{val as string}</div>
                        <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{label as string}</div>
                      </div>
                    ))}
                  </div>
                </Card>
                )}
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>射手依赖度</div>
                  {(deepV.scorers ?? []).length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "7px 0" }}>榜单暂无官方返回</div>}
                  {deepV.scorers?.map((s: V) => (
                    <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: s.side === "h" ? "var(--home)" : "var(--team-away)" }} />
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{s.name}</span>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>{s.goals} 球</span>
                      {s.share != null && (
                        <span style={{ width: 90 }}>
                          <span style={{ display: "block", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden", marginBottom: 2 }}>
                            <span style={{ display: "block", height: "100%", background: "var(--gold)", width: `${s.share}%` }} />
                          </span>
                          <span style={{ fontSize: 11, color: "var(--fg-2)" }}>
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
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: c.side === "h" ? "var(--home)" : "var(--team-away)" }} />
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{c.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{c.meta}</span>
                    </div>
                  ))}
                  {deepV.transfers?.map((t: V) => (
                    <div key={t.team} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, borderRadius: 4, padding: "2px 6px", background: "var(--inset)", color: t.tag === "转入" ? "var(--green)" : t.tag === "转出" ? "var(--red)" : "var(--fg-3)" }}>{t.tag}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{t.team}</span>
                      <span style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{t.x}</span>
                    </div>
                  ))}
                  <div style={{ height: 6 }} />
                </Card>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {deepV.seasonPanel && (deepV.seasonPanel.home || deepV.seasonPanel.away) && (
                  <Card style={{ padding: "8px 14px" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>赛季面板 <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 400 }}>主客拆分 · 官方统计</span></div>
                    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr 1fr", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                      <span style={{ fontSize: 11, color: "var(--fg-3)" }}>指标</span>
                      <span style={{ fontSize: 11, color: "var(--home)", textAlign: "center", fontWeight: 700 }}>{h.home}</span>
                      <span style={{ fontSize: 11, color: "var(--team-away)", textAlign: "center", fontWeight: 700 }}>{h.away}</span>
                    </div>
                    {[
                      ["总战绩", (x: V) => x?.rec, ""],
                      ["主场", (x: V) => x?.recHome?.slice(2), ""],
                      ["客场", (x: V) => x?.recAway?.slice(2), ""],
                      ["场均进球", (x: V) => x?.gf, ""],
                      ["场均失球", (x: V) => x?.ga, ""],
                      ["零封", (x: V) => x?.clean, " 场"],
                      ["最长连胜", (x: V) => x?.streak, ""],
                    ].map(([label, get, suffix]) => (
                      <div key={label as string} style={{ display: "grid", gridTemplateColumns: "64px 1fr 1fr", padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
                        <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{label as string}</span>
                        <span className="mono" style={{ fontSize: 11.5, textAlign: "center", color: "var(--fg-mid)" }}>{((get as V)(deepV.seasonPanel.home) ?? "—") + (suffix as string)}</span>
                        <span className="mono" style={{ fontSize: 11.5, textAlign: "center", color: "var(--fg-mid)" }}>{((get as V)(deepV.seasonPanel.away) ?? "—") + (suffix as string)}</span>
                      </div>
                    ))}
                  </Card>
                )}
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>联赛榜单 <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 400 }}>各榜前 5 · 点击看球员</span></div>
                  {(deepV.lb ?? []).length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)", padding: "7px 0" }}>官方榜单数据积累中</div>}
                  {deepV.lb?.map((b: V) => (
                    <div key={b.tag} style={{ paddingBottom: 6 }}>
                      <div style={{ fontSize: 11.5, fontWeight: 800, color: b.tagC, padding: "5px 0 2px" }}>{b.tag}</div>
                      {(b.rows ?? []).map((r: V) => (
                        <div key={r.rk} onClick={() => r.pid && setPlayer({ id: r.pid, name: r.name, season: h.season })} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--line-soft)", cursor: r.pid ? "pointer" : "default" }}>
                          <span className="mono" style={{ width: 14, fontSize: 11, fontWeight: 800, color: r.rk === 1 ? "var(--gold)" : "var(--fg-3)" }}>{r.rk}</span>
                          <span style={{ flex: 1, fontSize: 11, fontWeight: 700, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--fg-3)" }}>{r.team}</span></span>
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{r.v}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </Card>
                <Card style={{ padding: "8px 14px 4px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, padding: "4px 0 6px" }}>赛季场均评分 · 关键球员</div>
                  {(deepV.ratings ?? []).length === 0 && <div style={{ fontSize: 11.5, color: "var(--fg-3)", padding: "7px 0" }}>评分暂无官方返回</div>}
                  {deepV.ratings?.map((r: V) => {
                    const bc = r.r >= 8 ? ["var(--selected-bg-strong)", "var(--gold)"] : r.r >= 7 ? ["rgba(46,204,138,.16)", "var(--green)"] : ["rgba(149,155,166,.16)", "var(--fg-3)"];
                    return (
                      <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: r.side === "h" ? "var(--home)" : "var(--team-away)" }} />
                        <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                        <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "2px 6px" }}>{r.pos}</span>
                        <span className="mono" style={{ width: 34, textAlign: "center", fontSize: 11, fontWeight: 800, borderRadius: 5, padding: "3px 0", background: bc[0], color: bc[1] }}>{r.r.toFixed(1)}</span>
                      </div>
                    );
                  })}
                  <div style={{ height: 6 }} />
                </Card>
                <Card style={{ padding: "10px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>教练荣誉</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {(deepV.motiv ?? []).length === 0 && <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>暂无官方荣誉数据</span>}
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
      <QuoteHistorySheet target={history} onClose={() => setHistory(null)} />
      <PlayerSheet target={player} onClose={() => setPlayer(null)} />
    </div>
  );
}
