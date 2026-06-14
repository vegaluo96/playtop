"use client";

/** 比赛详情:指数走势 / 对比 / 技术面 / 阵容 / 情报 / 深挖(6 tab) */
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { RefreshSheet } from "@/components/refresh-sheet";
import { ShareSheet, type ShareData } from "@/components/share-sheet";
import { Card, Chip, EmptyBox, SectionTitle, ShareIcon } from "@/components/ui";
import { dayLabel, f2, hhmm } from "@/lib/format";

import { Flash, usePoll } from "@/components/live";
import { MarketValue, type MarketCellData } from "@/components/market-cell";
import { RefreshCountdownText } from "@/components/refresh-countdown";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";
import { PlayerAvatar, TeamLogo } from "@/components/img";
import { PlayerSheet, type PlayerTarget } from "@/components/player-sheet";
import { MatchTimeline, WeatherCard } from "@/components/match-timeline";
import { CornersRefNote, FatigueCard, RoadSection, SameOddsCard } from "@/components/insights";
import { QuoteHistorySheet, type HistoryTarget } from "@/components/quote-history";
import { OddsCompareMatrix, OddsEuTrendPanel, OddsSegmentedTabs, OddsTrendPanel, type OddsMarketKey } from "@/components/odds-workbench";
import { SITE_HOST } from "@/lib/site";

import type { DetailView } from "@/server/views/detail";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any; // 局部多态占位(行/玩法/球员等异构子对象的 map 回调)
/** 详情响应 = detailView 视图模型 + 路由附加字段(前后端字段编译期对齐) */
type DetailResp = DetailView & { ok: boolean; loggedIn: boolean; unlocked: boolean; price: number };
type DeepResp = NonNullable<DetailView["deep"]>;

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

/** 详情积分榜聚焦两队及上下邻近行(完整表见数据页);表很短时全显示 */
function focusStandings(table: V[]): V[] {
  if (!Array.isArray(table) || table.length <= 6) return table ?? [];
  const keep = new Set<number>();
  table.forEach((r, i) => {
    if (r.hl) { keep.add(i - 1); keep.add(i); keep.add(i + 1); }
  });
  const rows = table.filter((_, i) => keep.has(i));
  return rows.length > 0 ? rows : table;
}

/** 一级导航 4 组(390px 一屏放下):指数(走势/对比/玩法)| 赛况 | 人员(阵容+情报)| 深度(深挖+报告) */
const TABS: [string, string][] = [
  ["odds", "指数"], ["match", "赛况"], ["squad", "人员"], ["deep", "深度"],
];

const FORM_STYLE: Record<string, { bg: string; c: string }> = {
  胜: { bg: "var(--success-bg)", c: "var(--green)" },
  平: { bg: "var(--neutral-bg)", c: "var(--fg-3)" },
  负: { bg: "var(--danger-bg)", c: "var(--red)" },
};
const EXTRA_MARKET_THREE_COL = new Set(["fh1x2", "double", "exact", "htft"]);
const extraMarketGrid = (m: V) => EXTRA_MARKET_THREE_COL.has(String(m?.key)) ? "repeat(3,minmax(0,1fr))" : "repeat(2,minmax(0,1fr))";

export default function MatchRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal initialMatchId={Number(id)} /> : <MobileMatchDetail id={id} />;
}

function MobileMatchDetail({ id }: { id: string }) {
  const [v, setV] = useState<DetailResp | null>(null);
  const [tab, setTab] = useState("odds");
  const [oddsSub, setOddsSub] = useState<OddsMarketKey>("ah");
  const [deepV, setDeepV] = useState<DeepResp | null>(null);
  const [rfOpen, setRfOpen] = useState(false);
  const [share, setShare] = useState<ShareData | null>(null);
  const [err, setErr] = useState("");
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [player, setPlayer] = useState<PlayerTarget | null>(null);
  const [history, setHistory] = useState<HistoryTarget | null>(null);
  const { prefs, me } = useApp();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/match/${id}?tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setV(j);
      else setErr(j.error || "加载失败");
    } catch {
      setErr("网络异常");
    } finally {
      setLastAt(Date.now());
    }
  }, [id, prefs.tz]);

  useEffect(() => {
    void load();
  }, [load]);
  // 滚球 3s(交易所级跳动),赛前 10s;后台 tab 暂停
  usePoll(load, v?.header?.live ? 3_000 : 10_000);

  useEffect(() => {
    void fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: "match_view", id: Number(id) }) });
  }, [id]);

  useEffect(() => {
    if (tab === "deep" && !deepV) {
      void fetch(`/api/match/${id}?tz=${encodeURIComponent(prefs.tz)}&deep=1`, { cache: "no-store" })
        .then((r) => r.json())
        .then((j) => j.ok && setDeepV(j.deep ?? {}));
    }
  }, [tab, deepV, id, prefs.tz]);

  if (!v)
    return err ? (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-3)", fontSize: 12 }}>{err}</div>
    ) : (
      <div style={{ flex: 1, padding: "14px 14px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="skel" style={{ height: 16, width: 180, margin: "0 auto" }} />
        <div className="skel" style={{ height: 52 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 46 }} />)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 32 }} />)}
        </div>
        <div className="skel" style={{ height: 200 }} />
        <div className="skel" style={{ height: 140 }} />
      </div>
    );

  const h = v.header;
  const openShare = () =>
    setShare({
      title: `${h.home} vs ${h.away}`,
      sub: `${h.league} · ${h.live ? (h.ht ? "中场休息" : `${h.elapsed ?? ""}' 进行中`) : `${dayLabel(h.kickoff, prefs.tz)} ${hhmm(h.kickoff, prefs.tz)}`}`,
      v1: v.summary.ah ? `${v.summary.ah.text} ${v.summary.ah.w.split("/")[0]}` : "—",
      v2: v.summary.ou ? `${v.summary.ou.text} ${v.summary.ou.w.split("/")[0]}` : "—",
      v3: v.summary.eu?.w ?? "—",
      url: `${SITE_HOST}/match/${h.id}`,
      inviteCode: me.inviteCode,
    });

  const liveOddsStrip =
    h.live && v.liveOdds ? (
      <>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "6px 4px 8px" }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>滚球实时盘</div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />
            <span className="mono" style={{ fontSize: 11, color: "var(--red)", fontWeight: 800, whiteSpace: "nowrap" }}>LIVE · {h.fresh.freq}刷新</span>
          </div>
        </div>
        <div style={{ background: "var(--card)", border: "1px solid var(--danger-border)", borderRadius: 12, padding: "4px 14px", marginBottom: 12 }}>
          {v.liveOdds.map((r: V) => (
            <div key={r.mk} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--line-soft)" }}>
              <span style={{ flexShrink: 0, width: 54, fontSize: 11, fontWeight: 800, borderRadius: 4, padding: "2px 0", textAlign: "center", background: "var(--inset)", color: "var(--fg-2)" }}>{r.mk}</span>
              <span style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                {r.susp && <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-3)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>封盘中</span>}
                <MarketValue v={r.v || "—"} small dim={!!r.susp} />
              </span>
            </div>
          ))}
        </div>
      </>
    ) : null;

  const lineupPitch = (side: V, color: string) =>
    side && (
      <>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "14px 8px", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 8, minHeight: 320, boxSizing: "border-box" }}>
          {side.rows.map((row: V[], i: number) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-evenly", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
              {row.map((p: V) => (
                <div key={p.n} onClick={() => p.id && setPlayer({ id: p.id, name: p.n, season: h.season })} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: row.length >= 5 ? 56 : row.length === 4 ? 70 : 82, minWidth: 0, flexShrink: 1, cursor: p.id ? "pointer" : "default" }}>
                  <PlayerAvatar id={p.id} name={p.n} num={p.num} size={28} ring={color} />
                  <span title={p.n} style={{ width: "100%", minHeight: 26, fontSize: 10.5, lineHeight: 1.2, color: "var(--fg-mid)", textAlign: "center", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere", wordBreak: "break-word" }}>{p.n}</span>
                </div>
              ))}
            </div>
          ))}
          {side.coach && <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>主教练 · {side.coach}</div>}
        </div>
        {side.subs?.length > 0 && (
          <Card style={{ marginTop: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 6 }}>替补席</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {side.subs.map((p: V) => (
                <span key={p.n} className="mono" style={{ fontSize: 11.5, color: "var(--fg-mid)", background: "var(--inset)", borderRadius: 6, padding: "3px 8px" }}>
                  {p.num != null ? `${p.num} ` : ""}{p.n}
                </span>
              ))}
            </div>
          </Card>
        )}
      </>
    );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px 4px", minHeight: 40, boxSizing: "border-box" }}>
        <button type="button" onClick={() => router.back()} aria-label="返回" style={{ width: 38, height: 38, border: "1px solid var(--line)", borderRadius: 999, background: "var(--card)", color: "var(--fg-2)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 22, lineHeight: 1, flexShrink: 0 }}>‹</button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 10.5, color: "var(--fg-3)", fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>比赛详情</div>
          <div style={{ marginTop: 3, fontSize: 12, color: "var(--fg-2)", fontWeight: 750, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.league} · {h.round}</div>
        </div>
        <button type="button" onClick={openShare} aria-label="分享" style={{ width: 38, height: 38, border: "1px solid var(--line)", borderRadius: 999, background: "var(--card)", color: "var(--fg-2)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
          <ShareIcon />
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center", padding: "0 16px 6px" }}>
        <div style={{ textAlign: "right", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
            <span style={{ fontSize: 16, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.home}</span>
            <TeamLogo id={h.homeId} name={h.home} src={h.homeLogo} size={22} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--home)", marginTop: 2 }}>主场</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: h.live || h.finished ? "var(--gold)" : "var(--fg-4)", whiteSpace: "nowrap" }}>
            <Flash v={h.live || h.finished ? (h.score ?? "VS") : "VS"} />
          </div>
          <div style={{ fontSize: 11, color: h.live ? "var(--red)" : "var(--fg-3)", fontWeight: 600, marginTop: 1, whiteSpace: "nowrap" }}>
            {h.live ? (h.ht ? "中场休息" : `${h.elapsed ?? ""}' 进行中`) : h.finished ? "已完场" : `${dayLabel(h.kickoff, prefs.tz)} ${hhmm(h.kickoff, prefs.tz)} 开赛`}
          </div>
        </div>
        <div style={{ textAlign: "left", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TeamLogo id={h.awayId} name={h.away} src={h.awayLogo} size={22} />
            <span style={{ fontSize: 16, fontWeight: 800, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.away}</span>
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--team-away)", marginTop: 2 }}>客场</div>
        </div>
      </div>

      {/* 概览卡:压缩为单行(主水 · 盘口 · 客水),给指数表留更多空间;完整三行见下方百家对比 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "0 14px 8px" }}>
        {[
          { label: "让球", cell: pairSummary(v.summary.ah), mid: (c: MarketCellData) => c.text ?? "—" },
          { label: "大小", cell: pairSummary(v.summary.ou), mid: (c: MarketCellData) => c.text ?? "—" },
          { label: "胜平负", cell: euSummary(v.summary.eu), mid: (c: MarketCellData) => (c.d != null ? f2(c.d) : "—") },
        ].map(({ label, cell, mid }) => (
          <Card key={label} style={{ borderRadius: 8, padding: "5px 4px", textAlign: "center" }}>
            <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginBottom: 3 }}>{label}</div>
            <div className="mono" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 13.5, fontWeight: 800, whiteSpace: "nowrap" }}>
              <span>{cell?.h != null ? f2(cell.h) : "—"}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-3)" }}>{cell ? mid(cell) : "—"}</span>
              <span>{cell?.a != null ? f2(cell.a) : "—"}</span>
            </div>
          </Card>
        ))}
      </div>

      <div onClick={() => setRfOpen(true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 16px 6px", cursor: "pointer" }}>
        <span style={{ fontSize: 11, color: "var(--fg-3)", whiteSpace: "nowrap" }}>
          <RefreshCountdownText finished={h.finished} fresh={h.fresh} oddsAt={v.summary.oddsAt} fallbackAt={lastAt} />
        </span>
        <span style={{ fontSize: 11, color: "var(--gold)", fontWeight: 700, whiteSpace: "nowrap" }}>规则 ›</span>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 12px 10px", overflowX: "auto", flexShrink: 0 }}>
        {TABS.map(([k, label]) => (
          <div key={k} style={{ position: "relative", flex: 1, display: "flex" }}>
            <Chip label={label} active={tab === k} onClick={() => setTab(k)} style={{ borderRadius: 8, fontWeight: 700, flex: 1, textAlign: "center" }} />
            {k === "match" && h.live && <span className="livepulse" style={{ position: "absolute", top: 5, right: 9, width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />}
          </div>
        ))}
      </div>
      {tab === "odds" && <OddsSegmentedTabs value={oddsSub} onChange={setOddsSub} />}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 16px", minHeight: 0 }}>
        {tab === "odds" && oddsSub === "ah" && (
          <>
            {liveOddsStrip}
            <SectionTitle title="让球指数" right={h.finished ? "初始 / 终盘" : "初始 / 即时"} />
            <OddsCompareMatrix market="ah" rows={v.comp.ah} compact finished={h.finished} onHistory={(c) => c.bid && setHistory({ id: h.id, mk: "ah", bid: c.bid, co: c.co })} />
            <OddsTrendPanel market="ah" title="让球指数走势" data={v.odds.ah} index={v.odds.index?.ah} kickoff={h.kickoff} tz={prefs.tz} compact onHistory={() => setHistory({ id: h.id, mk: "ah" })} />
          </>
        )}

        {tab === "odds" && oddsSub === "eu" && (
          <>
            {liveOddsStrip}
            <SectionTitle title="欧指" right="主胜 / 平局 / 客胜" />
            <OddsCompareMatrix market="eu" rows={v.comp.eu} euMeta={v.comp.euMeta} compact finished={h.finished} onHistory={(c) => c.bid && setHistory({ id: h.id, mk: "eu", bid: c.bid, co: c.co })} />
            <OddsEuTrendPanel rows={v.odds.eu} index={v.odds.index?.eu} kickoff={h.kickoff} tz={prefs.tz} compact onHistory={() => setHistory({ id: h.id, mk: "eu" })} />
          </>
        )}

        {tab === "odds" && oddsSub === "ou" && (
          <>
            {liveOddsStrip}
            <SectionTitle title="进球数" right="大球 / 总进球 / 小球" />
            <OddsCompareMatrix market="ou" rows={v.comp.ou} compact finished={h.finished} onHistory={(c) => c.bid && setHistory({ id: h.id, mk: "ou", bid: c.bid, co: c.co })} />
            <OddsTrendPanel market="ou" title="进球数走势" data={v.odds.ou} index={v.odds.index?.ou} kickoff={h.kickoff} tz={prefs.tz} compact onHistory={() => setHistory({ id: h.id, mk: "ou" })} />
          </>
        )}

        {tab === "odds" && oddsSub === "road" && (
          <>
            <RoadSection ins={v.insights} home={h.home} away={h.away} />
            <SameOddsCard so={v.insights?.sameOdds} />
            <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "10px 4px 0", lineHeight: 1.6 }}>{v.insights?.note}</div>
            <SectionTitle title="更多玩法" right="随指数更新" />
            {(v.markets ?? []).length === 0 && <EmptyBox title="暂无扩展玩法数据" sub={"开盘后将自动解析半场盘/角球/罚牌/波胆等玩法"} />}
            {(v.markets ?? []).map((m: V) => (
              <Card key={m.key} style={{ padding: "10px 14px", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>{m.name}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{m.bk}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: extraMarketGrid(m), gap: 6 }}>
                  {m.rows.map((r: V, i: number) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "7px 10px", minWidth: 0 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.v}</span>
                      <MarketValue v={r.odd} small style={{ color: "var(--gold)", justifyContent: "flex-end" }} />
                    </div>
                  ))}
                </div>
              </Card>
            ))}
            <CornersRefNote cr={v.insights?.cornersRef} home={h.home} away={h.away} />
            {(v.markets ?? []).length > 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "6px 4px 0", lineHeight: 1.6 }}>玩法指数为胜平负原值,来自单一公司当帧报价;仅供数据参考。</div>}
          </>
        )}

        {tab === "match" && (
          <>
            {v.tech.timeline && (
              <div style={{ marginTop: 6 }}>
                <MatchTimeline tl={v.tech.timeline} home={h.home} away={h.away} live={h.live} />
              </div>
            )}
            {/* 赛前置顶(影响指数的赛前因素),开赛后跟在直播时间轴后 */}
            <WeatherCard w={v.weather} style={{ marginTop: 8 }} />
            {!h.finished && <FatigueCard fa={v.insights?.fatigue} home={h.home} away={h.away} style={{ marginTop: 8 }} />}
            {h.live && (
              <>
                <SectionTitle title="实时技术统计" />
                {!v.tech.stats && <Card style={{ padding: "16px 12px", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>暂无技术统计,开赛后更新</Card>}
                {v.tech.stats && <Card style={{ padding: "10px 14px 6px" }}>
                  {(v.tech.stats ?? []).map((b: V) => (
                    <div key={b.label} style={{ marginBottom: 9 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                        <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{b.label}</span>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--team-away)" }}>{b.rv}</span>
                      </div>
                      <div style={{ display: "flex", gap: 3, height: 4 }}>
                        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--home)", borderRadius: 2, width: `${(b.l / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                        <div style={{ flex: 1, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--team-away)", borderRadius: 2, width: `${(b.r / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </Card>}
              </>
            )}

            {h.live && (
              <>
                <SectionTitle title="半场拆分 · 上半场" />
                {!v.tech.half && <Card style={{ padding: "16px 12px", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>暂无半场拆分数据</Card>}
                {v.tech.half && <Card style={{ padding: "10px 14px 6px" }}>
                  {(v.tech.half ?? []).map((b: V) => (
                    <div key={b.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                      <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{b.label}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--team-away)" }}>{b.rv}</span>
                    </div>
                  ))}
                  <div style={{ height: 4 }} />
                </Card>}
              </>
            )}

            <SectionTitle title="近况 · 最近 6 场" />
            <Card style={{ padding: "10px 14px" }}>
              {[[h.home, v.tech.formHome], [h.away, v.tech.formAway]].map(([name, form], idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: idx === 0 ? 8 : 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: idx === 0 ? undefined : "var(--fg-mid)" }}>{name as string}</span>
                  <div style={{ display: "flex", gap: 5 }}>
                    {(form as string[]).length === 0 && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>近期战绩暂无数据</span>}
                    {(form as string[]).map((ch, i) => {
                      const s = FORM_STYLE[ch] ?? FORM_STYLE.平;
                      return (
                        <span key={i} style={{ width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, background: s.bg, color: s.c }}>{ch}</span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </Card>

            {v.tech.minutes && (
              <>
                <SectionTitle title="进球时段分布" />
                <Card style={{ padding: "12px 14px 8px" }}>
                  <div style={{ display: "flex", gap: 14, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--home)" }} />{h.home}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--team-away)" }} />{h.away}
                    </span>
                  </div>
                  {v.tech.minutes.rows.map((r: V) => (
                    <div key={r.label} style={{ display: "grid", gridTemplateColumns: "44px 1fr 30px", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{r.label}</span>
                      <span style={{ display: "block" }}>
                        <span style={{ display: "block", height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden", marginBottom: 2 }}>
                          <span style={{ display: "block", height: "100%", background: "var(--home)", borderRadius: 3, width: `${Math.min(100, r.h * 3)}%` }} />
                        </span>
                        <span style={{ display: "block", height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", background: "var(--team-away)", borderRadius: 3, width: `${Math.min(100, r.a * 3)}%` }} />
                        </span>
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right" }}>{r.h}/{r.a}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: "var(--fg-3)", paddingTop: 4, lineHeight: 1.6 }}>{v.tech.minutes.note}</div>
                </Card>
              </>
            )}

            <SectionTitle title="历史交锋" />
            <Card style={{ overflow: "hidden" }}>
              {v.tech.h2h.length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>暂无交锋记录</div>}
              {v.tech.h2h.map((r: V, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 1fr 50px 44px 30px", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{r.d}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.c}</span>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, textAlign: "center" }}>{r.s}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, textAlign: "center", color: r.res === "胜" ? "var(--up)" : r.res === "负" ? "var(--down)" : "var(--fg-2)" }}>{r.res}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, textAlign: "center", color: r.ou === "大" ? "var(--gold)" : "var(--home)" }}>{r.ou}</span>
                </div>
              ))}
            </Card>

            <SectionTitle title="积分榜" right="两队及邻近 · 完整见数据页" />
            <Card style={{ overflow: "hidden" }}>
              {focusStandings(v.tech.standings?.table ?? []).length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>暂无积分榜数据</div>}
              {focusStandings(v.tech.standings?.table ?? []).length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 30px 64px 36px 36px", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
                  {["#", "球队", "赛", "胜/平/负", "净胜", "积分"].map((hd, i) => (
                    <span key={hd} style={{ fontSize: 11, color: "var(--fg-3)", textAlign: i >= 2 ? "center" : "left" }}>{hd}</span>
                  ))}
                </div>
              )}
              {focusStandings(v.tech.standings?.table ?? []).map((r: V) => (
                <div key={`${r.grp}-${r.rk}-${r.team}`} style={{ display: "grid", gridTemplateColumns: "28px 1fr 30px 64px 36px 36px", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)", background: r.hl ? "var(--selected-bg-soft)" : "transparent" }}>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: r.hl ? "var(--gold)" : "var(--fg-3)" }}>{r.rk}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <TeamLogo id={r.teamId} name={r.team} src={r.logo} size={15} />
                    <span style={{ fontSize: 12, fontWeight: r.hl ? 800 : 600, color: r.hl ? (r.hl === "h" ? "var(--home)" : "var(--team-away)") : "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.team}</span>
                  </span>
                  <span className="mono" style={{ fontSize: 11, textAlign: "center", color: "var(--fg-2)" }}>{r.p}</span>
                  <span className="mono" style={{ fontSize: 11, textAlign: "center", color: "var(--fg-2)" }}>{r.w}/{r.dr}/{r.l}</span>
                  <span className="mono" style={{ fontSize: 11, textAlign: "center", color: r.gd > 0 ? "var(--up)" : r.gd < 0 ? "var(--down)" : "var(--fg-2)" }}>{r.gd > 0 ? `+${r.gd}` : r.gd}</span>
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 800, textAlign: "center", color: "var(--gold)" }}>{r.pts}</span>
                </div>
              ))}
            </Card>
          </>
        )}

        {tab === "squad" &&
          (v.lineups.ready ? (
            <>
              <div style={{ margin: "6px 4px 8px", fontSize: 13, fontWeight: 700 }}>
                首发阵容 <span style={{ color: "var(--home)" }}>{h.home}</span> · <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{v.lineups.home.form}</span>
              </div>
              {lineupPitch(v.lineups.home, "var(--home)")}
              <div style={{ margin: "14px 4px 8px", fontSize: 13, fontWeight: 700 }}>
                首发阵容 <span style={{ color: "var(--team-away)" }}>{h.away}</span> · <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{v.lineups.away.form}</span>
              </div>
              {lineupPitch(v.lineups.away, "var(--team-away)")}
            </>
          ) : (
            <EmptyBox title="首发尚未公布" sub={"首发通常于开赛前约 40 分钟公布\n公布后将自动更新"} />
          ))}

        {tab === "squad" && (
          <>
            <SectionTitle title="伤停与情报" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {v.intel.length === 0 && <EmptyBox title="暂无伤停通报" sub="伤停状态随发布后更新" />}
              {v.intel.map((i: V, idx: number) => (
                <Card key={idx} style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, background: i.side === "主" ? "var(--team-home-bg)" : "var(--team-away-bg)", color: i.side === "主" ? "var(--home)" : "var(--team-away)" }}>{i.side}</span>
                  <span style={{ flex: 1, fontSize: 12, color: "var(--fg-mid)", lineHeight: 1.5 }}>{i.x}</span>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: i.tag === "缺阵" ? "var(--red)" : i.tag === "解禁" ? "var(--green)" : "var(--gold)" }}>{i.tag}</span>
                </Card>
              ))}
            </div>
            {v.intel.length > 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "10px 4px 0", lineHeight: 1.6 }}>伤停状态随发布后更新。</div>}
          </>
        )}

        {tab === "deep" && (
          <div
            onClick={() => router.push(`/report/${h.id}`)}
            style={{ padding: "12px 14px", marginBottom: 8, borderRadius: 12, border: "1px solid var(--selected-border)", background: "var(--card)", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
          >
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 800 }}>AI 概率报告</span>
              <span style={{ fontSize: 11, color: "var(--fg-2)" }}>指数解读 · 状态盘路 · 进球模型 · 随指数变化更新版本</span>
            </span>
            <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: "var(--gold)" }}>查看 ›</span>
          </div>
        )}
        {tab === "deep" &&
          (deepV ? (
            <>
              {deepV.seasonPanel && (deepV.seasonPanel.home || deepV.seasonPanel.away) && (
                <>
                  <SectionTitle title="赛季面板" right="主客拆分" />
                  <Card style={{ overflow: "hidden", marginBottom: 8 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
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
                      ["零封场次", (x: V) => x?.clean, " 场"],
                      ["最长连胜", (x: V) => x?.streak, " 连胜"],
                    ].map(([label, get, suffix]) => (
                      <div key={label as string} style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr", padding: "7px 12px", borderBottom: "1px solid var(--line-soft)" }}>
                        <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{label as string}</span>
                        <span className="mono" style={{ fontSize: 11.5, textAlign: "center", color: "var(--fg-mid)" }}>{((get as V)(deepV.seasonPanel.home) ?? "—") + (suffix as string)}</span>
                        <span className="mono" style={{ fontSize: 11.5, textAlign: "center", color: "var(--fg-mid)" }}>{((get as V)(deepV.seasonPanel.away) ?? "—") + (suffix as string)}</span>
                      </div>
                    ))}
                  </Card>
                </>
              )}

              {deepV.venue?.name && deepV.venue.name !== "—" && (<>
              <SectionTitle title="球场因素" />
              <Card style={{ padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>{deepV.venue?.name}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{deepV.venue?.city}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {[[deepV.venue?.cap, "容量"], [deepV.venue?.surface, "草皮"], [deepV.venue?.country || "—", "国家/地区"]].map(([val, label]) => (
                    <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 0", textAlign: "center" }}>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 800 }}>{val as string}</div>
                      <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 1 }}>{label as string}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 9 }}>当值主裁:{deepV.referee ?? "暂未公布"}</div>
              </Card>
              </>)}

              <SectionTitle title="射手依赖度" />
              <Card style={{ padding: "6px 14px" }}>
                {(deepV.scorers ?? []).length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>榜单暂无数据</div>}
                {deepV.scorers?.map((s: V) => (
                  <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: s.side === "h" ? "var(--home)" : "var(--team-away)" }} />
                    <span style={{ flex: 1 }}>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 700 }}>{s.name}</span>
                      <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{s.pos}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{s.goals} 球</span>
                    {s.share != null && (
                      <span style={{ width: 96 }}>
                        <span style={{ display: "block", height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden", marginBottom: 3 }}>
                          <span style={{ display: "block", height: "100%", background: "var(--gold)", borderRadius: 3, width: `${s.share}%` }} />
                        </span>
                        <span style={{ fontSize: 11, color: "var(--fg-2)" }}>
                          占全队进球 <span className="mono" style={{ color: "var(--gold)", fontWeight: 700 }}>{s.share}%</span>
                        </span>
                      </span>
                    )}
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "8px 0", lineHeight: 1.6 }}>依赖度越高,该射手缺阵或哑火对大小指数与让球指数的冲击越大。</div>
              </Card>

              <SectionTitle title="赛季场均评分 · 关键球员" />
              <Card style={{ padding: "4px 14px 6px" }}>
                {(deepV.ratings ?? []).length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>评分暂无数据</div>}
                {deepV.ratings?.map((r: V) => {
                  const bc = r.r >= 8 ? ["var(--selected-bg-strong)", "var(--gold)"] : r.r >= 7 ? ["var(--success-bg)", "var(--green)"] : ["var(--neutral-bg)", "var(--fg-3)"];
                  return (
                    <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: r.side === "h" ? "var(--home)" : "var(--team-away)" }} />
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "2px 6px" }}>{r.pos}</span>
                      <span className="mono" style={{ width: 34, textAlign: "center", fontSize: 11, fontWeight: 800, borderRadius: 5, padding: "3px 0", background: bc[0], color: bc[1] }}>{r.r != null ? r.r.toFixed(1) : "—"}</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "8px 0", lineHeight: 1.6 }}>开赛后切换为全员实时评分。</div>
              </Card>

              <SectionTitle title="教练 · 转会 · 阵容深度" />
              <Card style={{ padding: "6px 14px" }}>
                {deepV.coaches?.map((c: V) => (
                  <div key={c.name} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: c.side === "h" ? "var(--home)" : "var(--team-away)" }} />
                      <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{c.name}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{c.meta}</span>
                    </div>
                  </div>
                ))}
                {deepV.transfers?.map((t: V) => (
                  <div key={t.team} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, borderRadius: 4, padding: "2px 6px", background: "var(--inset)", color: t.tag === "转入" ? "var(--green)" : t.tag === "转出" ? "var(--red)" : "var(--fg-3)" }}>{t.tag}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{t.team}</span>
                    <span style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.5 }}>{t.x}</span>
                  </div>
                ))}
                {deepV.depth?.map((d2: V) => (
                  <div key={d2.team} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{d2.team}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{d2.x}</span>
                  </div>
                ))}
                <div style={{ height: 6 }} />
              </Card>

              <SectionTitle title="教练荣誉" />
              <Card style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
                {(deepV.motiv ?? []).length === 0 && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>暂无荣誉数据</span>}
                {deepV.motiv?.map((x: string) => (
                  <div key={x} style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--fg-2)", lineHeight: 1.6 }}>
                    <span style={{ color: "var(--gold)" }}>·</span>
                    <span>{x}</span>
                  </div>
                ))}
              </Card>
            </>
          ) : (
            <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0" }}>深挖数据加载中…</div>
          ))}
      </div>

      <RefreshSheet open={rfOpen} onClose={() => setRfOpen(false)} activeIdx={h.fresh.idx} />
      <QuoteHistorySheet target={history} onClose={() => setHistory(null)} />
      <PlayerSheet target={player} onClose={() => setPlayer(null)} />
      <ShareSheet open={!!share} onClose={() => setShare(null)} data={share} />
    </div>
  );
}
