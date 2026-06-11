"use client";

/** 比赛详情:盘口走势 / 百家对比 / 技术面 / 阵容 / 情报 / 深挖(6 tab) */
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { Legend, LineChart, type ChartRow } from "@/components/charts";
import { RefreshSheet } from "@/components/refresh-sheet";
import { ShareSheet, type ShareData } from "@/components/share-sheet";
import { Card, Chip, EmptyBox, SectionTitle, ShareIcon } from "@/components/ui";
import { hhmm } from "@/lib/format";
import { leagueColor } from "@/lib/leagues";
import { Flash, HeartBeat, useWorkerBeat } from "@/components/live";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";
import { SITE_HOST } from "@/lib/site";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any; // 视图模型由 /api/match/[id] 输出,字段见 src/server/views/detail.ts

const TABS: [string, string][] = [
  ["odds", "盘口走势"], ["comp", "百家对比"], ["tech", "技术面"], ["lineup", "阵容"], ["intel", "情报"], ["deep", "深挖"],
];

const FORM_STYLE: Record<string, { bg: string; c: string }> = {
  胜: { bg: "rgba(46,204,138,.16)", c: "#2ecc8a" },
  平: { bg: "rgba(139,148,168,.16)", c: "#959ba6" },
  负: { bg: "rgba(240,67,79,.16)", c: "#f0434f" },
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
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

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
      sub: `${h.league} · ${h.live ? `${h.elapsed ?? ""}' 进行中` : `今日 ${hhmm(h.kickoff, prefs.tz)}`}`,
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

  const trendBlock = (title: string, data: { rows: V[]; chart: ChartRow[]; startAt?: number | null }, legend: [string, string], cols: [string, string]) => (
    <>
      <SectionTitle title={title} right={data.chart.length > 1 ? `自 ${data.chart[0].t} 归档` : undefined} />
      <Card style={{ padding: "10px 8px 6px" }}>
        <LineChart rows={data.chart} id={title} />
        <Legend items={[{ color: "var(--home)", label: legend[0] }, { color: "var(--gold)", label: legend[1] }]} />
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
            <span className="mono" style={{ fontSize: 12, textAlign: "right" }}>{r.h}</span>
            <span className="mono" style={{ fontSize: 12, textAlign: "right" }}>{r.a}</span>
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
          <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{headEu ? "首帧 主/平/客" : "首帧 · 主/客"}</span>
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
      <div style={{ background: "linear-gradient(180deg,#10231a,#0d1b15)", border: "1px solid #1d3528", borderRadius: 12, padding: "14px 8px", display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 300, boxSizing: "border-box" }}>
        {side.rows.map((row: string[], i: number) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-evenly" }}>
            {row.map((name) => (
              <div key={name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 62 }}>
                <span className="mono" style={{ width: 26, height: 26, borderRadius: "50%", background: color, color: "#0a0b0f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800 }}>
                  {name.slice(0, 1)}
                </span>
                <span style={{ fontSize: 9.5, color: "var(--fg-mid)", textAlign: "center", whiteSpace: "nowrap" }}>{name}</span>
              </div>
            ))}
          </div>
        ))}
        {side.coach && <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)" }}>主教练 · {side.coach}</div>}
      </div>
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
          <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.home}</div>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--home)", marginTop: 2 }}>主场</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: h.live || h.finished ? "var(--gold)" : "var(--fg-4)", whiteSpace: "nowrap" }}>
            <Flash v={h.live || h.finished ? (h.score ?? "VS") : "VS"} />
          </div>
          <div style={{ fontSize: 10, color: h.live ? "var(--red)" : "var(--fg-3)", fontWeight: 600, marginTop: 1, whiteSpace: "nowrap" }}>
            {h.live ? `${h.elapsed ?? ""}' 进行中` : h.finished ? "已完场" : `今日 ${hhmm(h.kickoff, prefs.tz)} 开赛`}
          </div>
        </div>
        <div style={{ textAlign: "left", minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.away}</div>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--gold)", marginTop: 2 }}>客场</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "0 14px 10px" }}>
        {[
          ["亚盘", v.summary.ah ? `${v.summary.ah.text}` : "—", v.summary.ah?.w ?? ""],
          ["大小", v.summary.ou ? `${v.summary.ou.text}` : "—", v.summary.ou?.w ?? ""],
          ["胜平负", "", v.summary.eu?.w ?? "—"],
        ].map(([k, t, w]) => (
          <Card key={k as string} style={{ borderRadius: 8, padding: "6px 2px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 2 }}>{k}</div>
            <div style={{ fontSize: 10.5, display: "flex", justifyContent: "center", gap: 3 }}>
              {t ? <Flash v={t} style={{ color: "var(--gold)", fontWeight: 700 }} /> : null}
              <Flash v={w} className="mono" style={{ color: "var(--fg-mid)" }} />
            </div>
          </Card>
        ))}
      </div>

      <div onClick={() => setRfOpen(true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 16px 8px", cursor: "pointer", flexWrap: "wrap" }}>
        <span style={{ fontSize: 9.5, color: "var(--fg-3)" }}>⟳ {h.fresh.line}{v.summary.oddsAt ? ` · 盘口更新于 ${Math.max(0, Math.round((Date.now() - v.summary.oddsAt) / 60_000))}m前` : ""}</span>
        <span style={{ fontSize: 9.5, color: "var(--gold)", fontWeight: 700 }}>规则 ›</span>
        <HeartBeat lastAt={lastAt} intervalMs={10_000} workerAt={workerAt} showNext />
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
                    <span className="mono" style={{ fontSize: 9, color: "var(--red)", fontWeight: 700, whiteSpace: "nowrap" }}>LIVE · 每 1 分钟刷新</span>
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
            {trendBlock("亚盘水位走势", v.odds.ah, ["主队水位", "客队水位"], ["主水", "客水"])}
            <div style={{ height: 8 }} />
            {trendBlock("大小球水位走势", v.odds.ou, ["大球水位", "小球水位"], ["大水", "小水"])}
            <SectionTitle title="胜平负赔率走势" />
            <Card style={{ padding: "10px 8px 6px" }}>
              <LineChart rows={v.odds.euChart} id="eu" />
              <Legend items={[{ color: "var(--home)", label: "主胜" }, { color: "var(--fg-2)", label: "平局" }, { color: "var(--gold)", label: "客胜" }]} />
            </Card>
            <Card style={{ marginTop: 8, overflow: "hidden" }}>
              <Th cols={["时间", "主胜", "平局", "客胜"]} widths="62px 1fr 1fr 1fr" />
              {v.odds.eu.map((r: V, i: number) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "62px 1fr 1fr 1fr", padding: "7px 12px", alignItems: "center", borderBottom: "1px solid var(--line-soft)" }}>
                  <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.t}</span>
                  <span className="mono" style={{ fontSize: 12, textAlign: "right" }}>{r.h}</span>
                  <span className="mono" style={{ fontSize: 12, textAlign: "right", color: "var(--fg-2)" }}>{r.d}</span>
                  <span className="mono" style={{ fontSize: 12, textAlign: "right" }}>{r.a}</span>
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

        {tab === "tech" && (
          <>
            {h.live && v.tech.events && (
              <>
                <SectionTitle title="实时事件" />
                <Card style={{ padding: "4px 12px" }}>
                  {v.tech.events.map((e: V, i: number) => {
                    const icons: Record<string, [string, string, string]> = {
                      goal: ["●", "rgba(46,204,138,.16)", "#2ecc8a"],
                      yellow: ["▮", "rgba(233,185,73,.16)", "#e9b949"],
                      red: ["▮", "rgba(240,67,79,.16)", "#f0434f"],
                      sub: ["⇄", "rgba(91,157,255,.16)", "#5b9dff"],
                      var: ["VAR", "rgba(139,148,168,.16)", "#959ba6"],
                    };
                    const ic = icons[e.k] ?? icons.var;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                        <span className="mono" style={{ width: 36, fontSize: 11, color: "var(--fg-2)" }}>{e.m}</span>
                        <span style={{ width: 20, height: 20, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, background: ic[1], color: ic[2] }}>{ic[0]}</span>
                        <span style={{ flex: 1, fontSize: 12, color: "var(--fg-mid)" }}>{e.x}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: e.s === "主" ? "var(--home)" : "var(--gold)" }}>{e.s}</span>
                      </div>
                    );
                  })}
                </Card>
              </>
            )}
            {h.live && v.tech.stats && (
              <>
                <SectionTitle title="实时技术统计" />
                <Card style={{ padding: "10px 14px 6px" }}>
                  {v.tech.stats.map((b: V) => (
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
                </Card>
              </>
            )}

            {h.live && v.tech.half && (
              <>
                <SectionTitle title="半场拆分 · 上半场" />
                <Card style={{ padding: "10px 14px 6px" }}>
                  {v.tech.half.map((b: V) => (
                    <div key={b.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--home)" }}>{b.lv}</span>
                      <span style={{ fontSize: 10, color: "var(--fg-2)" }}>{b.label}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>{b.rv}</span>
                    </div>
                  ))}
                  <div style={{ height: 4 }} />
                </Card>
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

            <SectionTitle title="联赛排名" />
            <Card style={{ overflow: "hidden" }}>
              {v.tech.standings.length === 0 && <div style={{ padding: 14, fontSize: 11, color: "var(--fg-3)", textAlign: "center" }}>杯赛/数据积累中</div>}
              {v.tech.standings.map((r: V) => (
                <div key={r.team} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
                  <span className="mono" style={{ width: 24, height: 24, borderRadius: 6, background: "var(--inset)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "var(--gold)" }}>{r.rk}</span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "block", fontSize: 12, fontWeight: 700 }}>{r.team}</span>
                    <span style={{ fontSize: 10, color: "var(--fg-3)" }}>{r.ha}</span>
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <span className="mono" style={{ display: "block", fontSize: 11, color: "var(--fg-2)" }}>{r.rec}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{r.gd} · {r.pts}分</span>
                  </span>
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
                  <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 800, color: i.tag === "缺阵" ? "var(--red)" : i.tag === "解禁" ? "#2ecc8a" : "var(--gold)" }}>{i.tag}</span>
                </Card>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-3)", padding: "10px 4px 0", lineHeight: 1.6 }}>伤停状态随官方发布实时更新。</div>
          </>
        )}

        {tab === "deep" &&
          (deepV ? (
            <>
              <SectionTitle title="联赛榜单" />
              <Card style={{ padding: "4px 14px" }}>
                {deepV.lb?.map((r: V) => (
                  <div key={r.tag} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span style={{ flexShrink: 0, width: 44, fontSize: 10, fontWeight: 800, borderRadius: 4, padding: "2px 0", textAlign: "center", background: "var(--inset)", color: r.tagC }}>{r.tag}</span>
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.v}</span>
                  </div>
                ))}
                <div style={{ height: 5 }} />
              </Card>

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
                  const bc = r.r >= 8 ? ["rgba(233,185,73,.16)", "#e9b949"] : r.r >= 7 ? ["rgba(46,204,138,.16)", "#2ecc8a"] : ["rgba(139,148,168,.16)", "#959ba6"];
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
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "2px 6px", background: "var(--inset)", color: t.tag === "转入" ? "#2ecc8a" : t.tag === "转出" ? "#f0434f" : "#959ba6" }}>{t.tag}</span>
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
      <ShareSheet open={!!share} onClose={() => setShare(null)} data={share} />
    </div>
  );
}
