"use client";

/** 比赛详情:盘口走势 / 百家对比 / 技术面 / 阵容 / 情报 / 深挖(6 tab) */
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { type ChartRow } from "@/components/charts";
import { IndexChart } from "@/components/index-chart";
import { RefreshSheet } from "@/components/refresh-sheet";
import { ShareSheet, type ShareData } from "@/components/share-sheet";
import { Card, Chip, EmptyBox, SectionTitle, ShareIcon } from "@/components/ui";
import { ahText, dayLabel, hhmm } from "@/lib/format";
import { leagueColor } from "@/lib/leagues";
import { Flash, HeartBeat, usePoll, useWorkerBeat } from "@/components/live";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";
import { PlayerAvatar, TeamLogo } from "@/components/img";
import { PlayerSheet, type PlayerTarget } from "@/components/player-sheet";
import { SITE_HOST } from "@/lib/site";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any; // 视图模型由 /api/match/[id] 输出,字段见 src/server/views/detail.ts

const TABS: [string, string][] = [
  ["odds", "盘口走势"], ["comp", "百家对比"], ["markets", "玩法"], ["tech", "技术面"], ["lineup", "阵容"], ["intel", "情报"], ["deep", "深挖"],
];

const FORM_STYLE: Record<string, { bg: string; c: string }> = {
  胜: { bg: "rgba(46,204,138,.16)", c: "var(--green)" },
  平: { bg: "rgba(139,148,168,.16)", c: "#959ba6" },
  负: { bg: "rgba(240,67,79,.16)", c: "var(--red)" },
};

export default function MatchRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <Terminal initialMatchId={Number(id)} /> : <MobileMatchDetail id={id} />;
}

function MobileMatchDetail({ id }: { id: string }) {
  const [v, setV] = useState<V | null>(null);
  const [tab, setTab] = useState("odds");
  const [deepV, setDeepV] = useState<V | null>(null);
  const [rfOpen, setRfOpen] = useState(false);
  const [share, setShare] = useState<ShareData | null>(null);
  const [err, setErr] = useState("");
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [player, setPlayer] = useState<PlayerTarget | null>(null);
  const workerAt = useWorkerBeat();
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
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-3)", fontSize: 12 }}>
        {err || "加载中…"}
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

  const Th = ({ cols, widths }: { cols: string[]; widths: string }) => (
    <div style={{ display: "grid", gridTemplateColumns: widths, padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
      {cols.map((c, i) => (
        <span key={i} style={{ fontSize: 10, color: "var(--fg-3)", textAlign: i > 0 ? "right" : "left" }}>{c}</span>
      ))}
    </div>
  );

  const trendBlock = (title: string, data: { rows: V[]; chart: ChartRow[]; startAt?: number | null }, idx: V, mk: "ah" | "ou", cols: [string, string]) => (
    <>
      <SectionTitle title={title} right={data.chart.length > 1 ? `自 ${data.chart[0].t} 归档` : undefined} />
      <Card style={{ padding: "10px 10px 8px" }}>
        <IndexChart
          data={idx}
          kickoff={h.kickoff}
          tz={prefs.tz}
          unit={mk === "ah" ? "主水指数" : "大球指数"}
          lineText={(l) => (l == null ? "" : mk === "ah" ? ahText(l) : `${l} 球`)}
          height={188}
        />
        <div style={{ fontSize: 9.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.6 }}>{idx?.method}</div>
      </Card>
      <Card style={{ marginTop: 8, overflow: "hidden" }}>
        <Th cols={["时间", "盘口", cols[0], cols[1]]} widths="62px 1fr 58px 58px" />
        {data.rows.length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>快照积累中</div>}
        {data.rows.map((r: V, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "62px 1fr 58px 58px", padding: "7px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.t}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: r.chg ? "var(--gold)" : "var(--fg-mid)" }}>{r.text}</span>
              {r.chg && <span style={{ fontSize: 9, fontWeight: 700, color: "var(--gold)" }}>变盘</span>}
            </span>
            <span className="mono" style={{ fontSize: 13, textAlign: "right" }}>{r.h}</span>
            <span className="mono" style={{ fontSize: 13, textAlign: "right" }}>{r.a}</span>
          </div>
        ))}
      </Card>
    </>
  );

  const compTable = (title: string, rows: V[], headEu = false) => (
    <>
      <SectionTitle title={title} />
      <Card style={{ overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 16px 1fr", padding: "8px 12px", borderBottom: "1px solid var(--line)", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--fg-3)" }}>公司</span>
          <span style={{ fontSize: 10, color: "var(--fg-3)" }} title="初盘=本站归档到的最早盘口(开赛前 14 天起持续归档)">{headEu ? "初盘 主/平/客" : "初盘 · 主/客"}</span>
          <span />
          <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{headEu ? "即时 主/平/客" : "即时 · 主/客"}</span>
        </div>
        {rows.length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>数据积累中</div>}
        {rows.map((c: V) => (
          <div key={c.co} style={{ display: "grid", gridTemplateColumns: "60px 1fr 16px 1fr", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>{c.co}</span>
            <span>
              {!headEu && <span style={{ display: "block", fontSize: 11, color: "var(--fg-2)", fontWeight: 600 }}>{c.iText}</span>}
              <span className="mono" style={{ fontSize: headEu ? 10.5 : 11, color: "var(--fg-3)" }}>{c.iW}</span>
            </span>
            <span style={{ fontSize: 11, color: "var(--fg-4)" }}>→</span>
            <span>
              {!headEu && <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: c.changed ? "var(--gold)" : "var(--fg-mid)" }}>{c.nText}</span>}
              <span className="mono" style={{ fontSize: headEu ? 10.5 : 11, color: "var(--fg-mid)" }}>{c.nW}</span>
            </span>
          </div>
        ))}
      </Card>
    </>
  );

  const lineupPitch = (side: V, color: string) =>
    side && (
      <>
        <div style={{ background: "linear-gradient(180deg,#10231a,#0d1b15)", border: "1px solid #1d3528", borderRadius: 12, padding: "14px 8px", display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 300, boxSizing: "border-box" }}>
          {side.rows.map((row: V[], i: number) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-evenly" }}>
              {row.map((p: V) => (
                <div key={p.n} onClick={() => p.id && setPlayer({ id: p.id, name: p.n, season: h.season })} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 62, cursor: p.id ? "pointer" : "default" }}>
                  <PlayerAvatar id={p.id} name={p.n} num={p.num} size={28} ring={color} />
                  <span style={{ fontSize: 9.5, color: "var(--fg-mid)", textAlign: "center", whiteSpace: "nowrap" }}>{p.n}</span>
                </div>
              ))}
            </div>
          ))}
          {side.coach && <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)" }}>主教练 · {side.coach}</div>}
        </div>
        {side.subs?.length > 0 && (
          <Card style={{ marginTop: 8, padding: "8px 12px" }}>
            <div style={{ fontSize: 10, color: "var(--fg-3)", marginBottom: 6 }}>替补席</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {side.subs.map((p: V) => (
                <span key={p.n} className="mono" style={{ fontSize: 10.5, color: "var(--fg-mid)", background: "var(--inset)", borderRadius: 6, padding: "3px 8px" }}>
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
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px 6px" }}>
        <div onClick={() => router.back()} style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--fg-2)", fontSize: 22, lineHeight: 1 }}>‹</div>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(h.leagueId) }} />
            <span style={{ fontSize: 12, color: "var(--fg-2)", fontWeight: 600, whiteSpace: "nowrap" }}>{h.league} · {h.round}</span>
          </div>
        </div>
        <div onClick={openShare} style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--fg-2)" }}>
          <ShareIcon />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center", padding: "2px 16px 10px" }}>
        <div style={{ textAlign: "right", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
            <TeamLogo id={h.homeId} name={h.home} size={22} />
            <span style={{ fontSize: 16, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.home}</span>
          </div>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--home)", marginTop: 2 }}>主场</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: h.live || h.finished ? "var(--gold)" : "var(--fg-4)", whiteSpace: "nowrap" }}>
            <Flash v={h.live || h.finished ? (h.score ?? "VS") : "VS"} />
          </div>
          <div style={{ fontSize: 10, color: h.live ? "var(--red)" : "var(--fg-3)", fontWeight: 600, marginTop: 1, whiteSpace: "nowrap" }}>
            {h.live ? (h.ht ? "中场休息" : `${h.elapsed ?? ""}' 进行中`) : h.finished ? "已完场" : `${dayLabel(h.kickoff, prefs.tz)} ${hhmm(h.kickoff, prefs.tz)} 开赛`}
          </div>
        </div>
        <div style={{ textAlign: "left", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <TeamLogo id={h.awayId} name={h.away} size={22} />
            <span style={{ fontSize: 16, fontWeight: 800, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.away}</span>
          </div>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--gold)", marginTop: 2 }}>客场</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "0 14px 10px" }}>
        {[
          ["亚盘", v.summary.ah ? `${v.summary.ah.text}` : "—", v.summary.ah?.w ?? "", v.summary.ah?.chgAt],
          ["大小", v.summary.ou ? `${v.summary.ou.text}` : "—", v.summary.ou?.w ?? "", v.summary.ou?.chgAt],
          ["胜平负", "", v.summary.eu?.w ?? "—", v.summary.eu?.chgAt],
        ].map(([k, t, w, at]) => (
          <Card key={k as string} style={{ borderRadius: 8, padding: "6px 2px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 2 }}>{k}</div>
            <div style={{ fontSize: 10.5, display: "flex", justifyContent: "center", gap: 3 }}>
              {t ? <Flash v={t as string} pulse={at as number | null} style={{ color: "var(--gold)", fontWeight: 700 }} /> : null}
              <Flash v={w as string} pulse={at as number | null} className="mono" style={{ color: "var(--fg-mid)" }} />
            </div>
          </Card>
        ))}
      </div>

      <div onClick={() => setRfOpen(true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 16px 8px", cursor: "pointer", flexWrap: "wrap" }}>
        <span style={{ fontSize: 9.5, color: "var(--fg-3)" }}>⟳ {h.fresh.line}{v.summary.oddsAt ? ` · 盘口更新于 ${Math.max(0, Math.round((Date.now() - v.summary.oddsAt) / 60_000))}m前` : ""}</span>
        <span style={{ fontSize: 9.5, color: "var(--gold)", fontWeight: 700 }}>规则 ›</span>
        {!h.finished && <HeartBeat lastAt={lastAt} intervalMs={10_000} workerAt={workerAt} showNext />}
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 12px 10px", overflowX: "auto", flexShrink: 0 }}>
        {TABS.map(([k, label]) => (
          <Chip key={k} label={label} active={tab === k} onClick={() => setTab(k)} style={{ borderRadius: 8, fontWeight: 700 }} />
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 16px", minHeight: 0 }}>
        {tab === "odds" && (
          <>
            {h.live && v.liveOdds && (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "6px 4px 8px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>滚球实时盘</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />
                    <span className="mono" style={{ fontSize: 9, color: "var(--red)", fontWeight: 700, whiteSpace: "nowrap" }}>LIVE · {h.fresh.freq}刷新</span>
                  </div>
                </div>
                <div style={{ background: "var(--card)", border: "1px solid rgba(240,67,79,.3)", borderRadius: 12, padding: "4px 14px", marginBottom: 14 }}>
                  {v.liveOdds.map((r: V) => (
                    <div key={r.mk} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ flexShrink: 0, width: 48, fontSize: 10, fontWeight: 800, borderRadius: 4, padding: "2px 0", textAlign: "center", background: "var(--inset)", color: "var(--fg-2)" }}>{r.mk}</span>
                      <span style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                        {r.susp && <span style={{ fontSize: 8.5, fontWeight: 800, color: "var(--fg-3)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>封盘中</span>}
                        <Flash v={r.v || "—"} className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: r.susp ? "var(--fg-3)" : "var(--fg)" }} />
                      </span>
                    </div>
                  ))}
                  <div style={{ height: 5 }} />
                </div>
              </>
            )}
            {trendBlock("亚盘走势 · 综合指数", v.odds.ah, v.odds.index?.ah, "ah", ["主水", "客水"])}
            <div style={{ height: 8 }} />
            {trendBlock("大小球走势 · 综合指数", v.odds.ou, v.odds.index?.ou, "ou", ["大水", "小水"])}
            <SectionTitle title="胜平负走势 · 综合指数" />
            <Card style={{ padding: "10px 10px 8px" }}>
              <IndexChart data={v.odds.index?.eu} kickoff={h.kickoff} tz={prefs.tz} unit="主胜概率" height={188} />
              <div style={{ fontSize: 9.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.6 }}>{v.odds.index?.eu?.method}</div>
            </Card>
            <Card style={{ marginTop: 8, overflow: "hidden" }}>
              <Th cols={["时间", "主胜", "平局", "客胜"]} widths="62px 1fr 1fr 1fr" />
              {v.odds.eu.map((r: V, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "62px 1fr 1fr 1fr", padding: "7px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                  <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.t}</span>
                  <span className="mono" style={{ fontSize: 13, textAlign: "right" }}>{r.h}</span>
                  <span className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--fg-2)" }}>{r.d}</span>
                  <span className="mono" style={{ fontSize: 13, textAlign: "right" }}>{r.a}</span>
                </div>
              ))}
            </Card>
          </>
        )}

        {tab === "comp" && (
          <>
            {compTable("亚盘 · 多公司对比", v.comp.ah)}
            {compTable("大小球 · 多公司对比", v.comp.ou)}
            {compTable("胜平负 · 多公司对比", v.comp.eu, true)}
            <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "10px 4px 0", lineHeight: 1.6 }}>各公司变盘时间与幅度可横向比对。</div>
          </>
        )}

        {tab === "markets" && (
          <>
            <SectionTitle title="更多玩法" right="数据随盘口归档实时更新" />
            {(v.markets ?? []).length === 0 && <EmptyBox title="暂无扩展玩法数据" sub={"开盘后将自动解析半场盘/角球/罚牌/波胆等玩法"} />}
            {(v.markets ?? []).map((m: V) => (
              <Card key={m.key} style={{ padding: "10px 14px", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>{m.name}</span>
                  <span style={{ fontSize: 9.5, color: "var(--fg-3)" }}>{m.bk}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: m.key === "exact" || m.key === "htft" ? "1fr 1fr 1fr" : "1fr 1fr", gap: 6 }}>
                  {m.rows.map((r: V, i: number) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--inset)", borderRadius: 8, padding: "7px 10px" }}>
                      <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.v}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 800, color: "var(--gold)" }}>{r.odd}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
            <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "6px 4px 0", lineHeight: 1.6 }}>玩法赔率为欧赔原值,来自单一公司当帧报价;仅供数据参考。</div>
          </>
        )}

        {tab === "tech" && (
          <>
            {h.live && (
              <>
                <SectionTitle title="实时事件" />
                {!v.tech.events && <Card style={{ padding: "16px 12px", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>暂无事件数据,随官方接口实时更新</Card>}
                {v.tech.events && <Card style={{ padding: "4px 12px" }}>
                  {(v.tech.events ?? []).map((e: V, i: number) => {
                    const icons: Record<string, [string, string, string]> = {
                      goal: ["●", "rgba(46,204,138,.16)", "var(--green)"],
                      yellow: ["▮", "rgba(233,185,73,.16)", "#e9b949"],
                      red: ["▮", "rgba(240,67,79,.16)", "var(--red)"],
                      sub: ["⇄", "rgba(91,157,255,.16)", "#5b9dff"],
                      var: ["VAR", "rgba(139,148,168,.16)", "#959ba6"],
                    };
                    const ic = icons[e.k] ?? icons.var;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                        <span className="mono" style={{ width: 36, fontSize: 11, color: "var(--fg-2)" }}>{e.m}</span>
                        <span style={{ width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, background: ic[1], color: ic[2] }}>{ic[0]}</span>
                        <span style={{ flex: 1, fontSize: 13, color: "var(--fg-mid)" }}>{e.x}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: e.s === "主" ? "var(--home)" : "var(--gold)" }}>{e.s}</span>
                      </div>
                    );
                  })}
                </Card>}
              </>
            )}
            {h.live && (
              <>
                <SectionTitle title="实时技术统计" />
                {!v.tech.stats && <Card style={{ padding: "16px 12px", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>暂无技术统计,随官方接口实时更新</Card>}
                {v.tech.stats && <Card style={{ padding: "10px 14px 6px" }}>
                  {(v.tech.stats ?? []).map((b: V) => (
                    <div key={b.label} style={{ marginBottom: 9 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                        <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{b.label}</span>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>{b.rv}</span>
                      </div>
                      <div style={{ display: "flex", gap: 3, height: 4 }}>
                        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--home)", borderRadius: 2, width: `${(b.l / (b.l + b.r || 1)) * 100}%` }} />
                        </div>
                        <div style={{ flex: 1, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", background: "var(--gold)", borderRadius: 2, width: `${(b.r / (b.l + b.r || 1)) * 100}%` }} />
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
                      <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{b.label}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>{b.rv}</span>
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
                    {(form as string[]).length === 0 && <span style={{ fontSize: 10, color: "var(--fg-3)" }}>数据积累中</span>}
                    {(form as string[]).map((ch, i) => {
                      const s = FORM_STYLE[ch] ?? FORM_STYLE.平;
                      return (
                        <span key={i} style={{ width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, background: s.bg, color: s.c }}>{ch}</span>
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
                    <span style={{ fontSize: 10, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--home)" }} />{h.home}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--fg-2)", display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--gold)" }} />{h.away}
                    </span>
                  </div>
                  {v.tech.minutes.rows.map((r: V) => (
                    <div key={r.label} style={{ display: "grid", gridTemplateColumns: "44px 1fr 30px", gap: 8, alignItems: "center", marginBottom: 6 }}>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{r.label}</span>
                      <span style={{ display: "block" }}>
                        <span style={{ display: "block", height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden", marginBottom: 2 }}>
                          <span style={{ display: "block", height: "100%", background: "var(--home)", borderRadius: 3, width: `${Math.min(100, r.h * 3)}%` }} />
                        </span>
                        <span style={{ display: "block", height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", background: "var(--gold)", borderRadius: 3, width: `${Math.min(100, r.a * 3)}%` }} />
                        </span>
                      </span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-2)", textAlign: "right" }}>{r.h}/{r.a}</span>
                    </div>
                  ))}
                  <div style={{ fontSize: 10, color: "var(--fg-3)", paddingTop: 4, lineHeight: 1.6 }}>{v.tech.minutes.note}</div>
                </Card>
              </>
            )}

            <SectionTitle title="历史交锋" />
            <Card style={{ overflow: "hidden" }}>
              {v.tech.h2h.length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>暂无交锋记录</div>}
              {v.tech.h2h.map((r: V, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 1fr 50px 44px 30px", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{r.d}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.c}</span>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, textAlign: "center" }}>{r.s}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, textAlign: "center", color: r.res === "胜" ? "var(--up)" : r.res === "负" ? "var(--down)" : "var(--fg-2)" }}>{r.res}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, textAlign: "center", color: r.ou === "大" ? "var(--gold)" : "var(--home)" }}>{r.ou}</span>
                </div>
              ))}
            </Card>

            <SectionTitle title="积分榜" right="完整榜单 · 两队高亮" />
            <Card style={{ overflow: "hidden" }}>
              {(v.tech.standings?.table ?? []).length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>杯赛/数据积累中</div>}
              {(v.tech.standings?.table ?? []).length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 30px 64px 36px 36px", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
                  {["#", "球队", "赛", "胜/平/负", "净胜", "积分"].map((hd, i) => (
                    <span key={hd} style={{ fontSize: 9.5, color: "var(--fg-3)", textAlign: i >= 2 ? "center" : "left" }}>{hd}</span>
                  ))}
                </div>
              )}
              {(v.tech.standings?.table ?? []).map((r: V) => (
                <div key={`${r.grp}-${r.rk}-${r.team}`} style={{ display: "grid", gridTemplateColumns: "28px 1fr 30px 64px 36px 36px", padding: "8px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)", background: r.hl ? "rgba(233,185,73,.07)" : "transparent" }}>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: r.hl ? "var(--gold)" : "var(--fg-3)" }}>{r.rk}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <TeamLogo id={r.teamId} name={r.team} size={15} />
                    <span style={{ fontSize: 12, fontWeight: r.hl ? 800 : 600, color: r.hl ? (r.hl === "h" ? "var(--home)" : "var(--gold)") : "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.team}</span>
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

        {tab === "lineup" &&
          (v.lineups.ready ? (
            <>
              <div style={{ margin: "6px 4px 8px", fontSize: 13, fontWeight: 700 }}>
                首发阵容 <span style={{ color: "var(--home)" }}>{h.home}</span> · <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{v.lineups.home.form}</span>
              </div>
              {lineupPitch(v.lineups.home, "var(--home)")}
              <div style={{ margin: "14px 4px 8px", fontSize: 13, fontWeight: 700 }}>
                首发阵容 <span style={{ color: "var(--gold)" }}>{h.away}</span> · <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{v.lineups.away.form}</span>
              </div>
              {lineupPitch(v.lineups.away, "var(--gold)")}
            </>
          ) : (
            <EmptyBox title="官方首发尚未公布" sub={"官方首发通常于开赛前约 40 分钟公布\n公布后将自动更新"} />
          ))}

        {tab === "intel" && (
          <>
            <SectionTitle title="伤停与情报" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {v.intel.length === 0 && <EmptyBox title="暂无官方伤停通报" sub="伤停状态随官方发布实时更新" />}
              {v.intel.map((i: V, idx: number) => (
                <Card key={idx} style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, background: i.side === "主" ? "rgba(91,157,255,.16)" : "rgba(233,185,73,.16)", color: i.side === "主" ? "var(--home)" : "var(--gold)" }}>{i.side}</span>
                  <span style={{ flex: 1, fontSize: 12, color: "var(--fg-mid)", lineHeight: 1.5 }}>{i.x}</span>
                  <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, color: i.tag === "缺阵" ? "var(--red)" : i.tag === "解禁" ? "var(--green)" : "var(--gold)" }}>{i.tag}</span>
                </Card>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "10px 4px 0", lineHeight: 1.6 }}>伤停状态随官方发布实时更新。</div>
          </>
        )}

        {tab === "deep" &&
          (deepV ? (
            <>
              {deepV.seasonPanel && (deepV.seasonPanel.home || deepV.seasonPanel.away) && (
                <>
                  <SectionTitle title="赛季面板" right="主客拆分 · 官方统计" />
                  <Card style={{ overflow: "hidden", marginBottom: 8 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 1fr", padding: "7px 12px", borderBottom: "1px solid var(--line)" }}>
                      <span style={{ fontSize: 9.5, color: "var(--fg-3)" }}>指标</span>
                      <span style={{ fontSize: 9.5, color: "var(--home)", textAlign: "center", fontWeight: 700 }}>{h.home}</span>
                      <span style={{ fontSize: 9.5, color: "var(--gold)", textAlign: "center", fontWeight: 700 }}>{h.away}</span>
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
                        <span style={{ fontSize: 10.5, color: "var(--fg-3)" }}>{label as string}</span>
                        <span className="mono" style={{ fontSize: 11.5, textAlign: "center", color: "var(--fg-mid)" }}>{((get as V)(deepV.seasonPanel.home) ?? "—") + (suffix as string)}</span>
                        <span className="mono" style={{ fontSize: 11.5, textAlign: "center", color: "var(--fg-mid)" }}>{((get as V)(deepV.seasonPanel.away) ?? "—") + (suffix as string)}</span>
                      </div>
                    ))}
                  </Card>
                </>
              )}

              <SectionTitle title="联赛榜单" right="各榜前 5 · 点击看球员" />
              {deepV.lb?.map((b: V) => (
                <Card key={b.tag} style={{ padding: "8px 14px", marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: b.tagC, marginBottom: 4 }}>{b.tag}</div>
                  {(b.rows ?? []).length === 0 && <div style={{ fontSize: 10.5, color: "var(--fg-3)", padding: "4px 0" }}>数据积累中</div>}
                  {(b.rows ?? []).map((r: V) => (
                    <div key={r.rk} onClick={() => r.pid && setPlayer({ id: r.pid, name: r.name, season: h.season })} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: r.rk < (b.rows?.length ?? 0) ? "1px solid var(--line-soft)" : "none", cursor: r.pid ? "pointer" : "default" }}>
                      <span className="mono" style={{ width: 16, fontSize: 10.5, fontWeight: 800, color: r.rk === 1 ? "var(--gold)" : "var(--fg-3)" }}>{r.rk}</span>
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name} <span style={{ fontSize: 10, fontWeight: 400, color: "var(--fg-3)" }}>{r.team}</span></span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.v}</span>
                    </div>
                  ))}
                </Card>
              ))}

              <SectionTitle title="球场因素" />
              <Card style={{ padding: "12px 14px" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 800 }}>{deepV.venue?.name}</span>
                  <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{deepV.venue?.city}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {[[deepV.venue?.cap, "容量"], [deepV.venue?.surface, "草皮"], [deepV.venue?.country || "—", "国家/地区"]].map(([val, label]) => (
                    <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 0", textAlign: "center" }}>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 800 }}>{val as string}</div>
                      <div style={{ fontSize: 9, color: "var(--fg-3)", marginTop: 1 }}>{label as string}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginTop: 9 }}>当值主裁:{deepV.referee ?? "官方未公布"}</div>
              </Card>

              <SectionTitle title="射手依赖度" />
              <Card style={{ padding: "6px 14px" }}>
                {(deepV.scorers ?? []).length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>榜单数据积累中</div>}
                {deepV.scorers?.map((s: V) => (
                  <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: s.side === "h" ? "var(--home)" : "var(--gold)" }} />
                    <span style={{ flex: 1 }}>
                      <span style={{ display: "block", fontSize: 12, fontWeight: 700 }}>{s.name}</span>
                      <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{s.pos}</span>
                    </span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{s.goals} 球</span>
                    {s.share != null && (
                      <span style={{ width: 96 }}>
                        <span style={{ display: "block", height: 5, background: "var(--inset)", borderRadius: 3, overflow: "hidden", marginBottom: 3 }}>
                          <span style={{ display: "block", height: "100%", background: "linear-gradient(90deg,#8a6a1f,#e9b949)", borderRadius: 3, width: `${s.share}%` }} />
                        </span>
                        <span style={{ fontSize: 9, color: "var(--fg-2)" }}>
                          占全队进球 <span className="mono" style={{ color: "var(--gold)", fontWeight: 700 }}>{s.share}%</span>
                        </span>
                      </span>
                    )}
                  </div>
                ))}
                <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "8px 0", lineHeight: 1.6 }}>依赖度越高,该射手缺阵或哑火对大小球与让球盘的冲击越大。</div>
              </Card>

              <SectionTitle title="赛季场均评分 · 关键球员" />
              <Card style={{ padding: "4px 14px 6px" }}>
                {(deepV.ratings ?? []).length === 0 && <div style={{ padding: 10, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>评分数据积累中</div>}
                {deepV.ratings?.map((r: V) => {
                  const bc = r.r >= 8 ? ["rgba(233,185,73,.16)", "#e9b949"] : r.r >= 7 ? ["rgba(46,204,138,.16)", "var(--green)"] : ["rgba(139,148,168,.16)", "#959ba6"];
                  return (
                    <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: r.side === "h" ? "var(--home)" : "var(--gold)" }} />
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                      <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "2px 6px" }}>{r.pos}</span>
                      <span className="mono" style={{ width: 34, textAlign: "center", fontSize: 11, fontWeight: 800, borderRadius: 5, padding: "3px 0", background: bc[0], color: bc[1] }}>{r.r.toFixed(1)}</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "8px 0", lineHeight: 1.6 }}>开赛后切换为全员实时评分。</div>
              </Card>

              <SectionTitle title="教练 · 转会 · 阵容深度" />
              <Card style={{ padding: "6px 14px" }}>
                {deepV.coaches?.map((c: V) => (
                  <div key={c.name} style={{ padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: c.side === "h" ? "var(--home)" : "var(--gold)" }} />
                      <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{c.name}</span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--fg-2)" }}>{c.meta}</span>
                    </div>
                  </div>
                ))}
                {deepV.transfers?.map((t: V) => (
                  <div key={t.team} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "2px 6px", background: "var(--inset)", color: t.tag === "转入" ? "var(--green)" : t.tag === "转出" ? "var(--red)" : "#959ba6" }}>{t.tag}</span>
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
                {(deepV.motiv ?? []).length === 0 && <span style={{ fontSize: 11, color: "var(--fg-3)" }}>数据积累中</span>}
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
      <PlayerSheet target={player} onClose={() => setPlayer(null)} />
      <ShareSheet open={!!share} onClose={() => setShare(null)} data={share} />
    </div>
  );
}
