"use client";

/**
 * 桌面三栏终端(≥1080px):左选场 → 中深读 → 右盯流。
 * 与移动端共享 token、数据契约与商业规则,仅视图层分叉。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { f2, hhmm, mdLabel, parseTzOffset } from "@/lib/format";
import { LEAGUES, leagueColor, leagueZh } from "@/lib/leagues";
import { Flash, HeartBeat, useNewIds, usePoll, useTierIntervals, useWorkerBeat } from "@/components/live";
import { TIERS, tierFreqText } from "@/server/af/schedule";
import { Modal, ModalTitle } from "./modal";
import { CenterPane } from "./center";
import { AccountDrawer } from "./drawer";
import { useRechargeTiers } from "@/components/unlock-flow";
import { AnnouncementBar } from "@/components/announcement-bar";
import { TeamLogo } from "@/components/img";
import { useSiteConfig } from "@/components/site-config";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export type DTab = "odds" | "comp" | "markets" | "tech" | "report" | "lineup" | "intel" | "deep";
export type DModal =
  | { kind: "recharge" }
  | { kind: "refresh" }
  | { kind: "record" }
  | { kind: "move"; data: V }
  | { kind: "ledger" }
  | { kind: "invlog" }
  | { kind: "unlock"; data: { id: number; match: string; price: number } }
  | null;

export function typeColor(t: string): string {
  return t === "升盘" ? "var(--up)" : t === "降盘" ? "var(--down)" : "var(--gold)";
}

export function Terminal({ initialMatchId, initialTab, initialDrawer }: { initialMatchId?: number; initialTab?: DTab; initialDrawer?: boolean }) {
  const { prefs, me, refreshMe } = useApp();
  const router = useRouter();
  const [league, setLeague] = useState("all");
  const [day, setDay] = useState("today");
  const [liveCount, setLiveCount] = useState(0);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<V[]>([]);
  const [sel, setSel] = useState<number | null>(initialMatchId ?? null);
  const [tab, setTab] = useState<DTab>(initialTab ?? "odds");
  const [detail, setDetail] = useState<V | null>(null);
  const [moves, setMoves] = useState<V[]>([]);
  const [movesLoggedIn, setMovesLoggedIn] = useState(true);
  const [monF, setMonF] = useState("全部");
  const [pred, setPred] = useState<V | null>(null);
  const [record, setRecord] = useState<V | null>(null);
  const [modal, setModal] = useState<DModal>(null);
  const [drawer, setDrawer] = useState(!!initialDrawer);
  const [busy, setBusy] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const workerAt = useWorkerBeat();
  const tierIntervals = useTierIntervals(modal?.kind === "refresh");
  const { tiers: rechargeTiers, maintenance: rechargeMaintenance } = useRechargeTiers(modal?.kind === "recharge");
  const selRef = useRef<number | null>(sel);
  selRef.current = sel;
  const siteCfg = useSiteConfig();
  const leagueChips = siteCfg?.leagues ?? LEAGUES.map((l) => ({ id: l.id, zh: l.zh, color: l.color, on: true, wc: l.wc }));

  /* ── 取数 ── */
  const loadRows = useCallback(async () => {
    try {
      const j = await fetch(`/api/matches?day=${day}&league=${league}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" }).then((r) => r.json());
      if (j.ok) {
        setRows(j.rows);
        setLiveCount(j.liveCount ?? 0);
        if (selRef.current == null && j.rows.length > 0) {
          const live = j.rows.find((r: V) => r.live && !r.masked);
          const first = j.rows.find((r: V) => !r.masked);
          setSel((live ?? first ?? j.rows[0]).id);
        }
      }
    } catch { /* 保留旧数据 */ } finally {
      setLastAt(Date.now());
    }
  }, [league, day, prefs.tz]);

  const loadDetail = useCallback(async () => {
    if (selRef.current == null) return;
    try {
      const j = await fetch(`/api/match/${selRef.current}?tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" }).then((r) => r.json());
      if (j.ok && j.header.id === selRef.current) setDetail(j);
    } catch { /* keep */ }
  }, [prefs.tz]);

  const loadMoves = useCallback(async () => {
    try {
      const j = await fetch(`/api/moves?type=${encodeURIComponent(monF)}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" }).then((r) => r.json());
      if (j.ok) {
        setMoves(j.rows);
        setMovesLoggedIn(j.loggedIn);
      }
    } catch { /* keep */ }
  }, [monF, prefs.tz]);

  const loadPred = useCallback(async () => {
    if (selRef.current == null) return;
    try {
      const j = await fetch(`/api/predictions?fixture=${selRef.current}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" }).then((r) => r.json());
      if (j.ok) {
        setPred(j.cards[0] ?? null);
        setRecord(j.record);
      }
    } catch { /* keep */ }
  }, [prefs.tz]);

  useEffect(() => {
    void loadRows(); // 切日期/联赛立即刷新
  }, [loadRows]);
  // 滚球行/直播视图 3s,其余 10s;后台 tab 全部暂停(usePoll)
  const hasLiveRow = day === "live" || rows.some((r: V) => r.live);
  usePoll(loadRows, hasLiveRow ? 3_000 : 10_000);
  useEffect(() => {
    setDetail(null);
    setPred(null);
    if (sel != null) void fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: "match_view", id: sel }) });
    void loadDetail();
    void loadPred();
  }, [sel, loadDetail, loadPred]);
  usePoll(loadDetail, detail?.header?.live ? 3_000 : 10_000);
  usePoll(loadPred, 60_000);
  useEffect(() => {
    void loadMoves(); // 切筛选立即刷新
  }, [loadMoves]);
  usePoll(loadMoves, 5_000);

  const freshMoveIds = useNewIds(moves.map((m) => m.id));

  /* ── 解锁/充值(与移动同一契约)── */
  const requestUnlock = (target: { id: number; match: string; price: number }) => {
    if (!me.loggedIn) {
      router.push("/login");
      return;
    }
    setModal({ kind: "unlock", data: target });
  };
  const confirmUnlock = async () => {
    if (modal?.kind !== "unlock" || busy) return;
    if (me.pts < modal.data.price) {
      setModal({ kind: "recharge" });
      return;
    }
    setBusy(true);
    try {
      const j = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixtureId: modal.data.id }),
      }).then((r) => r.json());
      if (j.ok) {
        await refreshMe();
        setModal(null);
        void loadPred();
        void loadRows();
      } else if (j.error === "余额不足") setModal({ kind: "recharge" });
      else {
        alert(j.error || "解锁失败");
        setModal(null);
      }
    } finally {
      setBusy(false);
    }
  };
  const doRecharge = async (idx: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const j = await fetch("/api/wallet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "recharge", tier: idx }),
      }).then((r) => r.json());
      if (j.ok) {
        await refreshMe();
        setModal(null);
      } else alert(j.error || "充值失败");
    } finally {
      setBusy(false);
    }
  };

  const gotoMatchOdds = (fid: number) => {
    setModal(null);
    setSel(fid);
    setTab("odds");
  };

  const X = "-.--";

  return (
    <div className="desktop-root" style={{ position: "relative", width: "100%", height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--fg)", overflow: "hidden" }}>
      <AnnouncementBar compact />
      {/* ===== 顶栏 ===== */}
      <div style={{ flexShrink: 0, height: 52, display: "flex", alignItems: "center", gap: 18, padding: "0 20px", borderBottom: "1px solid var(--line)", background: "#0e1015" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.5 }}>
            足球<span style={{ color: "var(--gold)" }}>终端</span>
          </span>
          <span style={{ fontSize: 10, color: "var(--fg-3)" }}>亚盘 · 大小球 · 胜平负</span>
        </div>
        <span style={{ width: 1, height: 20, background: "var(--line)" }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>
          {mdLabel(Date.now(), prefs.tz)} · {prefs.tz}
        </span>
        <span style={{ flex: 1 }} />
        <span
          onClick={() => setModal({ kind: "refresh" })}
          style={{ fontSize: 10, color: "var(--fg-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1, cursor: "pointer" }}
        >
          ⟳ {detail?.header?.fresh?.line ?? "数据刷新规则"} ›
        </span>
        <HeartBeat lastAt={lastAt} intervalMs={10_000} workerAt={workerAt} showNext />
        {me.loggedIn ? (
          <span onClick={() => setDrawer(true)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "5px 10px", borderRadius: 8, border: "1px solid var(--line)" }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--fg-2)" strokeWidth="1.7" strokeLinecap="round">
              <circle cx="10" cy="6.5" r="3" />
              <path d="M3.5 17c1.3-3.2 3.7-4.8 6.5-4.8s5.2 1.6 6.5 4.8" />
            </svg>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{me.email}</span>
            <span style={{ fontSize: 10, color: "var(--fg-3)" }}>▾</span>
          </span>
        ) : (
          <span
            onClick={() => router.push("/login")}
            style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 8, padding: "6px 16px", fontSize: 11.5, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}
          >
            登录 / 注册
          </span>
        )}
      </div>

      {/* ===== 三栏 ===== */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(260px,320px) minmax(0,1fr) minmax(280px,360px)", minHeight: 0 }}>
        {/* 左栏 · 赛事列表 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--line)", background: "#0c0d12" }}>
          <div style={{ flexShrink: 0, padding: "12px 14px 8px" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, overflowX: "auto", paddingBottom: 2 }}>
              {[
                ["live", `直播 ${liveCount}`], ["today", "今日"], ["tmr", "明日"],
                ...Array.from({ length: 12 }, (_, i) => {
                  const n = i + 2;
                  const d = new Date(Date.now() + parseTzOffset(prefs.tz) * 3_600_000 + n * 86_400_000);
                  return [`d${n}`, `周${"日一二三四五六"[d.getUTCDay()]} ${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`];
                }),
              ].map(([k, label]) => (
                <div key={k} onClick={() => setDay(k)} style={{ flexShrink: 0, padding: "4px 10px", borderRadius: 999, fontSize: 10.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", background: day === k ? "rgba(233,185,73,.14)" : "var(--card)", color: day === k ? "var(--gold)" : "var(--fg-2)", border: `1px solid ${day === k ? "rgba(233,185,73,.45)" : "var(--line)"}` }}>
                  {label}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 800, flexShrink: 0 }}>赛事</span>
              <input
                placeholder="搜索球队…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 0, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "5px 10px", fontSize: 11, color: "var(--fg)", outline: "none" }}
              />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[{ id: "all", zh: "全部", color: "", wc: false }, ...leagueChips.map((l) => ({ id: String(l.id), zh: l.zh, color: l.color, wc: !!l.wc }))].map((l) => {
                const active = league === l.id;
                return l.wc ? (
                  <div key={l.id} onClick={() => setLeague(l.id)} className={active ? "wcglow" : undefined} style={{ padding: "4px 10px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, cursor: "pointer", background: active ? "rgba(233,185,73,.16)" : "var(--card)", color: active ? "var(--gold)" : "var(--fg-2)", border: `1px solid ${active ? "rgba(233,185,73,.65)" : "rgba(233,185,73,.28)"}` }}>
                    <span style={{ color: "var(--gold)" }}>★</span> {l.zh}
                  </div>
                ) : (
                  <div key={l.id} onClick={() => setLeague(l.id)} style={{ padding: "4px 10px", borderRadius: 999, fontSize: 10.5, fontWeight: 600, cursor: "pointer", background: active ? "rgba(233,185,73,.14)" : "var(--card)", color: active ? "var(--gold)" : "var(--fg-2)", border: `1px solid ${active ? "rgba(233,185,73,.45)" : "var(--line)"}` }}>
                    {l.zh}
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {(() => {
              const kw = search.trim().toLowerCase();
              const shown = kw ? rows.filter((m) => `${m.home}${m.away}`.toLowerCase().includes(kw)) : rows;
              return (
                <>
                  {shown.length === 0 && (
                    <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 11, padding: "40px 12px" }}>
                      {kw ? "没有匹配的球队" : "该时段暂无已开盘赛事"}
                    </div>
                  )}
                  {shown.map((m) => {
              const selected = sel === m.id;
              const tag = m.masked ? "注册可见" : m.free ? "免费" : m.unlocked ? "已解锁" : "";
              return (
                <div
                  key={m.id}
                  onClick={() => (m.masked ? router.push("/login") : gotoMatchOdds(m.id))}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 10px 10px", cursor: "pointer", borderBottom: "1px solid var(--card)", borderLeft: `3px solid ${selected ? "var(--gold)" : "transparent"}`, background: selected ? "rgba(233,185,73,.07)" : "transparent" }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden" }}>
                      <span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: leagueColor(m.leagueId) }} />
                      <span style={{ fontSize: 10, color: "var(--fg-3)", whiteSpace: "nowrap", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1 }}>{leagueZh(m.leagueId, m.leagueName)}</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", whiteSpace: "nowrap", flexShrink: 0 }}>{hhmm(m.kickoff, prefs.tz)}</span>
                      {m.live && (
                        <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "var(--red)", fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>
                          <span className="livepulse" style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--red)" }} />
                          {m.ht ? "中场" : m.elapsed != null ? `${m.elapsed}'` : "LIVE"}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                      <TeamLogo id={m.homeId} name={m.home} size={14} />
                      <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                        {m.home} <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>vs</span> {m.away}
                      </span>
                      {tag && (
                        <span style={{ fontSize: 8.5, fontWeight: 800, borderRadius: 3, padding: "1px 5px", flexShrink: 0, whiteSpace: "nowrap", background: m.free && !m.masked ? "rgba(46,204,138,.12)" : "rgba(233,185,73,.12)", color: m.free && !m.masked ? "var(--green)" : "var(--gold)" }}>{tag}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right", width: 54 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", whiteSpace: "nowrap", display: "flex", justifyContent: "flex-end" }}><Flash v={m.masked ? "●●" : (m.ah?.text ?? "—")} pulse={m.masked ? null : m.ah?.chgAt} /></div>
                    <div className="mono" style={{ fontSize: 9.5, color: "var(--fg-2)", whiteSpace: "nowrap", display: "flex", justifyContent: "flex-end" }}><Flash v={m.masked || !m.ah ? X : `${f2(m.ah.h)}/${f2(m.ah.a)}`} pulse={m.masked ? null : m.ah?.chgAt} pulseDir={m.ah?.hd} /></div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right", width: 54 }}>
                    <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", display: "flex", justifyContent: "flex-end" }}><Flash v={m.masked || m.ou?.line == null ? X : m.ou.line.toFixed(2)} pulse={m.masked ? null : m.ou?.chgAt} /></div>
                    <div className="mono" style={{ fontSize: 9.5, color: "var(--fg-2)", whiteSpace: "nowrap", display: "flex", justifyContent: "flex-end" }}><Flash v={m.masked || !m.ou ? X : `${f2(m.ou.h)}/${f2(m.ou.a)}`} pulse={m.masked ? null : m.ou?.chgAt} pulseDir={m.ou?.hd} /></div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right", width: 44 }}>
                    {[m.eu?.h, m.eu?.d, m.eu?.a].map((vv, i) => (
                      <div key={i} className="mono" style={{ fontSize: 9, lineHeight: "12px", color: i === 1 ? "var(--fg-3)" : "var(--fg-2)", display: "flex", justifyContent: "flex-end" }}>
                        <Flash v={m.masked || vv == null ? X : f2(vv)} pulse={m.masked ? null : m.eu?.chgAt} pulseDir={i === 0 ? m.eu?.hd : i === 2 ? m.eu?.ad : 0} />
                      </div>
                    ))}
                  </div>
                  <div style={{ flexShrink: 0, width: 34, textAlign: "right" }}>
                    <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: m.live ? "var(--gold)" : "var(--fg-4)", display: "flex", justifyContent: "flex-end" }}><Flash v={m.live || m.finished ? (m.score ?? "vs") : "vs"} /></div>
                  </div>
                </div>
              );
                  })}
                </>
              );
            })()}
          </div>
        </div>

        {/* 中栏 · 详情 */}
        <CenterPane detail={detail} tab={tab} setTab={setTab} pred={pred} requestUnlock={requestUnlock} tz={prefs.tz} loggedIn={me.loggedIn} />

        {/* 右栏 · 异动 + 本场预测 */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, borderLeft: "1px solid var(--line)", background: "#0c0d12" }}>
          <div style={{ flex: 1.2, display: "flex", flexDirection: "column", minHeight: 0, borderBottom: "1px solid var(--line)" }}>
            <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px 8px" }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>盘口异动</span>
              <HeartBeat lastAt={lastAt} intervalMs={10_000} workerAt={workerAt} />
            </div>
            <div style={{ flexShrink: 0, display: "flex", gap: 6, padding: "0 14px 8px" }}>
              {["全部", "滚球", "升盘", "降盘", "水位"].map((l) => (
                <div key={l} onClick={() => setMonF(l)} style={{ padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 600, cursor: "pointer", background: monF === l ? "rgba(233,185,73,.14)" : "var(--card)", color: monF === l ? "var(--gold)" : "var(--fg-2)", border: `1px solid ${monF === l ? "rgba(233,185,73,.45)" : "var(--line)"}` }}>
                  {l}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 10px 10px" }}>
              {moves.length === 0 && <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 11, padding: "30px 10px" }}>暂无异动记录</div>}
              {moves.map((f) => (
                <div
                  key={f.id}
                  className={freshMoveIds.has(f.id) ? "feed-in" : undefined}
                  onClick={() => (f.masked ? router.push("/login") : setModal({ kind: "move", data: f }))}
                  style={{ background: "var(--card)", border: "1px solid var(--line-soft)", borderRadius: 8, marginBottom: 6, padding: "8px 10px", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{f.t}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.match}</span>
                    {f.sev && <span style={{ fontSize: 8, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 3, padding: "1px 5px" }}>急变</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {f.live && <span style={{ fontSize: 8.5, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 3, padding: "1px 5px" }}>滚球</span>}
                    <span style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 3, padding: "1px 6px" }}>{f.mk}</span>
                    {f.bk && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-3)", background: "var(--inset)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 56 }}>{f.bk}</span>}
                    <span style={{ fontSize: 9.5, fontWeight: 800, color: typeColor(f.type) }}>{f.type}</span>
                    <span style={{ fontSize: 10.5, color: "var(--fg-2)", whiteSpace: "nowrap" }}>{f.from}</span>
                    <span style={{ fontSize: 9.5, color: typeColor(f.type) }}>→</span>
                    <span style={{ fontSize: 10.5, fontWeight: 800, color: typeColor(f.type), whiteSpace: "nowrap" }}>{f.to}</span>
                    <span style={{ flex: 1 }} />
                    <span className="mono" style={{ fontSize: 9, color: "var(--fg-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 90 }}>{f.masked ? "注册可见" : f.note}</span>
                  </div>
                </div>
              ))}
              {!movesLoggedIn && moves.length > 0 && (
                <div onClick={() => router.push("/login")} style={{ background: "linear-gradient(180deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.4)", borderRadius: 8, padding: 12, textAlign: "center", cursor: "pointer" }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, marginBottom: 2 }}>注册后免费查看全部异动</div>
                  <div style={{ fontSize: 9, color: "var(--fg-2)" }}>完全免费 · 注册再送 58 积分</div>
                </div>
              )}
            </div>
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ flexShrink: 0, display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "12px 14px 8px" }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>官方预测 · 本场</span>
              <span style={{ fontSize: 9, color: "var(--fg-3)" }}>唯一付费项</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 14px 14px" }}>
              <div onClick={() => setModal({ kind: "record" })} style={{ display: "flex", gap: 8, marginBottom: 10, cursor: "pointer" }}>
                {[
                  [record?.hitRate30 != null ? `${record.hitRate30}%` : "—", "近30天命中", "var(--gold)"],
                  [record ? `${record.yesterday.hit}/${record.yesterday.total}` : "—", "昨日战绩", undefined],
                  [record?.streak ? `${record.streak} 连红` : "—", "当前状态", "var(--up)"],
                ].map(([v, label, color]) => (
                  <div key={label as string} style={{ flex: 1, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, padding: "7px 0", textAlign: "center" }}>
                    <div className="mono" style={{ fontSize: 13, fontWeight: 800, color: color as string | undefined }}>{v as string}</div>
                    <div style={{ fontSize: 8.5, color: "var(--fg-3)" }}>{label as string}</div>
                  </div>
                ))}
              </div>

              {pred ? (
                <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "8px 10px", marginBottom: 10 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>建议</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: pred.locked ? "var(--fg-3)" : "var(--gold)" }}>{pred.locked ? "解锁后查看官方建议与方向" : pred.advice}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 9.5, color: "var(--home)", fontWeight: 700 }}>主胜 <span className="mono">{pred.pH}%</span></span>
                    <span style={{ fontSize: 9.5, color: "var(--fg-2)", fontWeight: 700 }}>平 <span className="mono">{pred.pD}%</span></span>
                    <span style={{ fontSize: 9.5, color: "var(--gold)", fontWeight: 700 }}>客胜 <span className="mono">{pred.pA}%</span></span>
                  </div>
                  <div style={{ display: "flex", height: 5, borderRadius: 3, overflow: "hidden", gap: 2, marginBottom: 10 }}>
                    <div style={{ background: "var(--home)", width: `${pred.pH}%` }} />
                    <div style={{ background: "#383d47", width: `${pred.pD}%` }} />
                    <div style={{ background: "var(--gold)", width: `${pred.pA}%` }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                    {[["预测胜者", pred.winnerText], ["大小球", pred.uoText], ["进球上限", pred.goalsText]].map(([label, v]) => (
                      <div key={label as string} style={{ background: "var(--inset)", borderRadius: 6, padding: "6px 4px", textAlign: "center" }}>
                        <div style={{ fontSize: 8.5, color: "var(--fg-3)", marginBottom: 2 }}>{label as string}</div>
                        <div style={{ fontSize: 10.5, fontWeight: 800 }}>{(v as string) ?? "●●●"}</div>
                      </div>
                    ))}
                  </div>
                  {pred.locked ? (
                    <>
                      <div
                        onClick={() => requestUnlock({ id: pred.id, match: pred.match, price: pred.price })}
                        style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 8, textAlign: "center", padding: "10px 0", fontSize: 12, fontWeight: 800, cursor: "pointer" }}
                      >
                        {pred.lockText}
                      </div>
                      <div style={{ textAlign: "center", fontSize: 9, color: "var(--fg-3)", marginTop: 6 }}>解锁后含 AI 分析报告 · 永久可见</div>
                    </>
                  ) : (
                    <>
                      <div onClick={() => setTab("report")} style={{ border: "1px solid rgba(233,185,73,.5)", color: "var(--gold)", borderRadius: 8, textAlign: "center", padding: "9px 0", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                        查看 AI 分析报告 ›
                      </div>
                      <div style={{ textAlign: "center", fontSize: 9, color: "var(--fg-3)", marginTop: 6 }}>已解锁 · 永久可见</div>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ background: "var(--card)", border: "1px dashed #272d3a", borderRadius: 10, padding: "24px 14px", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>
                  本场预测尚未生成,开盘后自动出现
                </div>
              )}

              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 8 }}>近 7 日命中</div>
                <div style={{ display: "flex", gap: 5 }}>
                  {(record?.week ?? []).map((b: V, i: number) => {
                    const pct = b.total > 0 ? b.hit / b.total : null;
                    return (
                      <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                        <span className="mono" style={{ fontSize: 7.5, color: "var(--fg-2)" }}>{b.total > 0 ? `${b.hit}/${b.total}` : "—"}</span>
                        <div style={{ width: "100%", height: 26, display: "flex", alignItems: "flex-end" }}>
                          <div style={{ width: "100%", borderRadius: 2, background: pct == null ? "#383d47" : pct >= 0.66 ? "var(--gold)" : "#9a7b30", height: pct == null ? 4 : Math.max(6, Math.round(pct * 26)) }} />
                        </div>
                        <span className="mono" style={{ fontSize: 7.5, color: "var(--fg-3)" }}>{b.date.slice(8)}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 9, paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>昨日预测复盘</div>
                  {(record?.yesterdayRows ?? []).length === 0 && <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "4px 0" }}>昨日暂无已结算预测</div>}
                  {(record?.yesterdayRows ?? []).map((y: V, i: number) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 0" }}>
                      <span style={{ flex: 1, fontSize: 10.5, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{y.match}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--gold)", flexShrink: 0, whiteSpace: "nowrap" }}>{y.pick}</span>
                      <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)", width: 26, textAlign: "right", flexShrink: 0 }}>{y.score}</span>
                      <span style={{ width: 14, textAlign: "center", fontSize: 11, fontWeight: 800, flexShrink: 0, color: y.hit ? "var(--up)" : "var(--down)" }}>{y.hit ? "✓" : "✗"}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ textAlign: "center", fontSize: 9, color: "var(--fg-4)", padding: "10px 8px 0", lineHeight: 1.6 }}>预测由官方模型生成,仅供参考,不构成投注建议。</div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 新人礼包 ===== */}
      {me.loggedIn && me.giftPending && (
        <div style={{ position: "absolute", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(4,5,9,.78)" }}>
          <div style={{ width: 340, background: "linear-gradient(180deg,#20242e,#14161d)", border: "1px solid rgba(233,185,73,.5)", borderRadius: 18, padding: "24px 22px", textAlign: "center" }}>
            <div style={{ width: 52, height: 52, borderRadius: "50%", background: "linear-gradient(135deg,var(--gold),var(--gold-2))", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 22, fontWeight: 800, color: "#0a0b0f" }}>礼</div>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>新人礼包</div>
            <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7, marginBottom: 16 }}>
              <span className="mono" style={{ color: "var(--gold)", fontWeight: 800, fontSize: 18 }}>58</span> 积分已备好
              <br />
              可解锁今日任意 1 场官方预测
            </div>
            <div
              onClick={async () => {
                await fetch("/api/wallet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "gift" }) });
                await refreshMe();
              }}
              style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 10, padding: "12px 0", fontSize: 14, fontWeight: 800, cursor: "pointer" }}
            >
              立即领取
            </div>
          </div>
        </div>
      )}

      {/* ===== 抽屉与弹窗 ===== */}
      {drawer && <AccountDrawer onClose={() => setDrawer(false)} openModal={setModal} />}

      <Modal open={modal?.kind === "unlock"} onClose={() => setModal(null)} width={420}>
        {modal?.kind === "unlock" && (
          <>
            <ModalTitle title={`解锁预测 · ${modal.data.match}`} />
            <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 14, lineHeight: 1.6 }}>官方模型预测(建议 / 胜者 / 大小球方向)+ AI 分析报告,解锁后永久可见</div>
            <div style={{ display: "flex", background: "var(--inset)", borderRadius: 10, padding: "11px 14px", marginBottom: 14, justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
                价格 <span className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{modal.data.price}</span> 积分
              </span>
              <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
                余额 <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: me.pts < modal.data.price ? "var(--down)" : "var(--up)" }}>{me.pts}</span> 积分
              </span>
            </div>
            <div onClick={confirmUnlock} style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 10, textAlign: "center", padding: "12px 0", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
              {busy ? "处理中…" : me.pts < modal.data.price ? "余额不足 · 去充值" : "确认解锁"}
            </div>
            <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)", marginTop: 8 }}>解锁后永久可见 · 开赛后价格上调至 58 积分</div>
          </>
        )}
      </Modal>

      <Modal open={modal?.kind === "recharge"} onClose={() => setModal(null)} width={520}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>充值积分</span>
          <span style={{ fontSize: 10, color: "var(--gold)", fontWeight: 700 }}>首充任意档位 +50%</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 14 }}>积分仅用于解锁比赛预测 · 1 元 = 10 积分起</div>
        {rechargeMaintenance && (
          <div style={{ background: "rgba(233,185,73,.1)", border: "1px solid rgba(233,185,73,.4)", borderRadius: 10, padding: "14px 12px", marginBottom: 10, textAlign: "center", fontSize: 12, color: "var(--gold)", fontWeight: 700 }}>
            充值通道维护中,请稍后再试
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10, opacity: rechargeMaintenance ? 0.35 : 1, pointerEvents: rechargeMaintenance ? "none" : "auto" }}>
          {rechargeTiers.map((tr, i) => (
            <div key={tr.rmb} onClick={() => doRecharge(i)} style={{ position: "relative", background: "var(--inset)", border: `1px solid ${tr.hot ? "rgba(233,185,73,.55)" : "var(--line)"}`, borderRadius: 10, padding: "12px 0 10px", textAlign: "center", cursor: "pointer" }}>
              {tr.hot && <span style={{ position: "absolute", top: -7, right: 8, background: "var(--gold)", color: "#0a0b0f", fontSize: 8, fontWeight: 800, borderRadius: 4, padding: "1px 5px" }}>最划算</span>}
              <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{tr.pts}</div>
              <div style={{ fontSize: 9, color: "var(--up)", fontWeight: 700, height: 13 }}>{tr.tag ?? ""}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>¥{tr.rmb}</div>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)" }}>演示环境:点击档位即模拟支付到账</div>
      </Modal>

      <Modal open={modal?.kind === "refresh"} onClose={() => setModal(null)} width={440}>
        <ModalTitle title="数据刷新规则" hint="越临近开球,刷新越快" />
        {TIERS.map((r) => {
          const active = detail?.header?.fresh?.idx === r.idx;
          return (
            <div key={r.idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, marginBottom: 4, background: active ? "rgba(233,185,73,.12)" : "#0e1117" }}>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: active ? "var(--gold)" : "var(--fg-mid)" }}>{r.label}</span>
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 800, color: active ? "var(--gold)" : "var(--fg-2)" }}>{tierFreqText(r.idx, tierIntervals?.[r.idx] ?? r.intervalMs)}</span>
            </div>
          );
        })}
        <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 8, lineHeight: 1.7 }}>赔率、赛况与阵容数据来自官方接口,平台按上表频率自动抓取;频率为后台当前生效配置,调整后此处实时同步。</div>
      </Modal>

      <Modal open={modal?.kind === "record"} onClose={() => setModal(null)} width={480}>
        <ModalTitle title="模型战绩" hint="预测对照赛果自动统计" />
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {(record?.week ?? []).map((b: V, i: number) => {
            const pct = b.total > 0 ? b.hit / b.total : null;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                <span className="mono" style={{ fontSize: 8, color: "var(--fg-2)" }}>{b.total > 0 ? `${b.hit}/${b.total}` : "—"}</span>
                <div style={{ width: "100%", height: 34, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ width: "100%", borderRadius: 3, background: pct == null ? "#383d47" : pct >= 0.66 ? "var(--gold)" : "#9a7b30", height: pct == null ? 4 : Math.max(8, Math.round(pct * 34)) }} />
                </div>
                <span className="mono" style={{ fontSize: 8, color: "var(--fg-3)" }}>{b.date.slice(8)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", marginBottom: 5 }}>昨日预测复盘</div>
          {(record?.yesterdayRows ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)" }}>昨日暂无已结算预测</div>}
          {(record?.yesterdayRows ?? []).map((y: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{y.match}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", flexShrink: 0 }}>{y.pick}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", width: 28, textAlign: "right", flexShrink: 0 }}>{y.score}</span>
              <span style={{ width: 16, textAlign: "center", fontSize: 12, fontWeight: 800, flexShrink: 0, color: y.hit ? "var(--up)" : "var(--down)" }}>{y.hit ? "✓" : "✗"}</span>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "var(--fg-3)", marginTop: 6 }}>战绩为模型历史预测对照赛果的统计,不构成投注建议</div>
        </div>
      </Modal>

      <Modal open={modal?.kind === "move"} onClose={() => setModal(null)} width={460}>
        {modal?.kind === "move" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(modal.data.leagueId) }} />
              <span style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 600 }}>{modal.data.league}</span>
              <span style={{ flex: 1 }} />
              {modal.data.sev && <span style={{ fontSize: 9, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 4, padding: "2px 6px" }}>急变</span>}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>{modal.data.match}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "3px 8px" }}>{modal.data.mkFull}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "3px 8px" }}>{modal.data.bk}</span>
              <span style={{ fontSize: 10, fontWeight: 800, borderRadius: 4, padding: "3px 8px", background: "var(--inset)", color: typeColor(modal.data.type) }}>{modal.data.type}</span>
            </div>
            <div style={{ background: "#0e1117", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
                <span />
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", textAlign: "right" }}>{modal.data.t0} 快照</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--gold)", textAlign: "right" }}>{modal.data.t} 快照</span>
              </div>
              {modal.data.rows.map((r: V) => {
                const na = parseFloat(r.a), nb = parseFloat(r.b);
                const bC = r.k === "盘口" ? (r.chg ? typeColor(modal.data.type) : "var(--fg)") : !isNaN(na) && !isNaN(nb) && na !== nb ? (nb > na ? "var(--up)" : "var(--down)") : "var(--fg)";
                return (
                  <div key={r.k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "9px 12px", borderBottom: "1px solid var(--line-soft)", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.k}</span>
                    <span className="mono" style={{ fontSize: 12.5, textAlign: "right", color: "var(--fg-2)" }}>{r.a}</span>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 800, textAlign: "right", color: bC }}>{r.b}</span>
                  </div>
                );
              })}
            </div>
            <div onClick={() => gotoMatchOdds(modal.data.fixtureId)} style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 10, textAlign: "center", padding: "11px 0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
              查看本场盘口走势
            </div>
          </>
        )}
      </Modal>

      <LedgerModal open={modal?.kind === "ledger"} onClose={() => setModal(null)} />
      <InviteLogModal open={modal?.kind === "invlog"} onClose={() => setModal(null)} />
    </div>
  );
}

function LedgerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<V[]>([]);
  useEffect(() => {
    if (open) void fetch("/api/wallet").then((r) => r.json()).then((j) => j.ok && setRows(j.ledger));
  }, [open]);
  const fmtT = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  return (
    <Modal open={open} onClose={onClose} width={460}>
      <ModalTitle title="充值 / 消费记录" hint={`共 ${rows.length} 笔`} />
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {rows.length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "16px 0", textAlign: "center" }}>暂无记录</div>}
        {rows.map((l, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.note}</span>
              <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{fmtT(l.created_at)}</span>
            </span>
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 800, flexShrink: 0, color: l.delta >= 0 ? "var(--up)" : "var(--down)" }}>{l.delta >= 0 ? `+${l.delta}` : l.delta}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function InviteLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<V | null>(null);
  useEffect(() => {
    if (open) void fetch("/api/invite").then((r) => r.json()).then((j) => j.ok && setData(j));
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} width={420}>
      <ModalTitle title="邀请记录" hint={`累计 ${data?.total ?? 0} 人 · +${data?.totalPts ?? 0} 积分`} />
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {(data?.log ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "16px 0", textAlign: "center" }}>暂无邀请记录</div>}
        {(data?.log ?? []).map((l: V, i: number) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{l.u}</span>
            <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{l.t}</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 800, color: l.credited > 0 ? "var(--up)" : "var(--fg-3)" }}>{l.credited > 0 ? "+1" : "未计入"}</span>
          </div>
        ))}
      </div>
      <div style={{ flexShrink: 0, fontSize: 9, color: "var(--fg-3)", marginTop: 8 }}>超出每日 10 / 每周 30 / 每月 100 上限的部分不计入</div>
    </Modal>
  );
}
