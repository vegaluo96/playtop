"use client";

/** 赛事列表(首页):日期/联赛筛选 + 三列等宽盘口卡(64px),免注册打码由服务端执行 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { RefreshSheet } from "@/components/refresh-sheet";
import { AnnouncementBar } from "@/components/announcement-bar";
import { Chip } from "@/components/ui";
import { f2, hhmm, mdLabel, parseTzOffset } from "@/lib/format";
import { LEAGUES, leagueColor, leagueZh } from "@/lib/leagues";
import { Flash, HeartBeat, usePoll, useWorkerBeat } from "@/components/live";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";

interface Cell {
  text: string;
  h: number;
  a: number;
  d: number | null;
  hd: number;
  ad: number;
  line: number | null;
}
interface Row {
  id: number;
  leagueId: number;
  leagueName: string;
  kickoff: number;
  live: boolean;
  finished: boolean;
  elapsed: number | null;
  ht: boolean;
  score: string | null;
  home: string;
  away: string;
  moved: boolean;
  masked: boolean;
  free: boolean;
  unlocked: boolean;
  ah: Cell | null;
  ou: Cell | null;
  eu: Cell | null;
}

const X = "-.--";

function ArrowVal({ v, d, masked }: { v: number | undefined; d: number | undefined; masked: boolean }) {
  const ch = !masked && d ? (d > 0 ? "▲" : "▼") : "";
  return (
    <div style={{ height: 18, display: "flex", alignItems: "center", justifyContent: "center", gap: 3 }}>
      <Flash v={masked || v == null ? X : f2(v)} className="mono" style={{ fontSize: 12.5, fontWeight: 600 }} />
      <span style={{ fontSize: 8, color: d && d > 0 ? "var(--up)" : "var(--down)" }}>{ch}</span>
    </div>
  );
}

export default function MatchesRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <Terminal /> : <MobileMatchesPage />;
}

function MobileMatchesPage() {
  const [day, setDay] = useState("today");
  const [league, setLeague] = useState("all");
  const [rows, setRows] = useState<Row[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [rfOpen, setRfOpen] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const workerAt = useWorkerBeat();
  const { prefs } = useApp();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/matches?day=${day}&league=${league}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setRows(j.rows);
        setLiveCount(j.liveCount);
      }
    } catch {
      /* 网络抖动下保留旧数据 */
    } finally {
      setLoaded(true);
      setLastAt(Date.now());
    }
  }, [day, league, prefs.tz]);

  useEffect(() => {
    void load(); // 切日期/联赛立即刷新
  }, [load]);
  // 直播视图/列表含滚球行 → 3s(交易所级跳动,只渲染真实变化);其余 10s;后台 tab 暂停
  const hasLive = day === "live" || rows.some((r) => r.live);
  usePoll(load, hasLive ? 3_000 : 10_000);

  const dateLabel = `${mdLabel(Date.now(), prefs.tz)} · ${prefs.tz}`;
  // 14 天日期带:直播 | 今日 | 明日 | 周X 日期…(worker 提前 14 天归档赛程与赔率)
  const off = parseTzOffset(prefs.tz);
  const dateChips = [
    { k: "live", label: `直播 ${liveCount}` },
    { k: "today", label: "今日" },
    { k: "tmr", label: "明日" },
    ...Array.from({ length: 12 }, (_, i) => {
      const n = i + 2;
      const d = new Date(Date.now() + off * 3_600_000 + n * 86_400_000);
      return { k: `d${n}`, label: `周${"日一二三四五六"[d.getUTCDay()]} ${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}` };
    }),
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <AnnouncementBar />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 8px" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 0.5 }}>
            足球<span style={{ color: "var(--gold)" }}>终端</span>
          </div>
          <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 1 }}>亚盘 · 大小球 · 胜平负</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div className="mono" style={{ fontSize: 9, color: "var(--fg-3)", whiteSpace: "nowrap" }}>{dateLabel}</div>
          <div onClick={() => setRfOpen(true)} style={{ fontSize: 9, color: "var(--gold)", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
            ⟳ 数据刷新规则 ›
          </div>
          <HeartBeat lastAt={lastAt} intervalMs={10_000} workerAt={workerAt} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "6px 16px 8px", overflowX: "auto", flexShrink: 0 }}>
        {dateChips.map((c) => (
          <Chip key={c.k} label={c.label} active={day === c.k} onClick={() => setDay(c.k)} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto", flexShrink: 0 }}>
        <Chip label="全部" active={league === "all"} onClick={() => setLeague("all")} style={{ padding: "5px 12px", fontSize: 11 }} />
        {LEAGUES.map((l) =>
          l.wc ? (
            // 世界杯:仅以 ★ 与微弱描边突出,未选中态不得与「选中」混淆(选中=金底填充,与其他 chip 同语义)
            <div
              key={l.id}
              onClick={() => setLeague(String(l.id))}
              className={league === String(l.id) ? "wcglow" : undefined}
              style={{
                position: "relative", overflow: "hidden", flexShrink: 0, padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: league === String(l.id) ? "rgba(233,185,73,.16)" : "var(--card)",
                color: league === String(l.id) ? "var(--gold)" : "var(--fg-2)",
                border: `1px solid ${league === String(l.id) ? "rgba(233,185,73,.65)" : "rgba(233,185,73,.28)"}`,
              }}
            >
              {league === String(l.id) && (
                <span className="wcsweep" style={{ position: "absolute", top: 0, left: 0, width: 36, height: "100%", background: "linear-gradient(100deg,transparent,rgba(255,255,255,.22),transparent)" }} />
              )}
              <span style={{ position: "relative" }}><span style={{ color: "var(--gold)" }}>★</span> {l.zh}</span>
            </div>
          ) : (
            <Chip key={l.id} label={l.zh} active={league === String(l.id)} onClick={() => setLeague(String(l.id))} style={{ padding: "5px 12px", fontSize: 11 }} />
          ),
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 64px 64px 64px", gap: 8, padding: "4px 24px 6px 20px", alignItems: "center" }}>
        {["对阵", "亚盘", "大小", "胜平负"].map((h, i) => (
          <div key={h} style={{ fontSize: 10, color: "var(--fg-3)", textAlign: i === 0 ? "left" : "center" }}>{h}</div>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {loaded && rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0" }}>该时段暂无已开盘赛事</div>
        )}
        {rows.map((m) => {
          const tag = m.masked ? "注册可见" : m.free ? "免费预测" : m.unlocked ? "预测已解锁" : "";
          return (
            <div
              key={m.id}
              onClick={() => (m.masked ? router.push("/login") : router.push(`/match/${m.id}`))}
              style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, marginBottom: 8, padding: "9px 12px 10px", cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(m.leagueId) }} />
                <span style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 600 }}>{leagueZh(m.leagueId, m.leagueName)}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{hhmm(m.kickoff, prefs.tz)}</span>
                {m.live && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--red)", fontWeight: 700 }}>
                    <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)" }} />
                    {m.ht ? "中场" : m.elapsed != null ? `${m.elapsed}'` : "LIVE"}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {m.moved && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: "var(--gold)", border: "1px solid rgba(233,185,73,.45)", borderRadius: 4, padding: "1px 5px" }}>异动</span>
                )}
                {tag && (
                  <span
                    style={{
                      fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "1px 6px",
                      background: m.masked ? "rgba(233,185,73,.12)" : m.free ? "rgba(46,204,138,.12)" : "var(--inset)",
                      color: m.masked ? "var(--gold)" : m.free ? "#2ecc8a" : "var(--fg-2)",
                      border: `1px solid ${m.masked ? "rgba(233,185,73,.4)" : m.free ? "rgba(46,204,138,.4)" : "var(--line)"}`,
                    }}
                  >
                    {tag}
                  </span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 64px 64px 64px", gap: 8, alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ height: 21, display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, color: "var(--home)", background: "rgba(91,157,255,.12)", borderRadius: 3, padding: "1px 4px" }}>主</span>
                    <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.home}</span>
                  </div>
                  <div className="mono" style={{ height: 16, display: "flex", alignItems: "center", fontSize: 11, color: m.live ? "var(--gold)" : "var(--fg-4)", paddingLeft: 1, whiteSpace: "nowrap" }}>
                    <Flash v={m.live || m.finished ? (m.score ?? "vs") : "vs"} />
                  </div>
                  <div style={{ height: 21, display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, color: "var(--gold)", background: "rgba(233,185,73,.12)", borderRadius: 3, padding: "1px 4px" }}>客</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.away}</span>
                  </div>
                </div>
                <div style={{ background: "var(--inset)", borderRadius: 8, padding: "3px 0" }}>
                  <ArrowVal v={m.ah?.h} d={m.ah?.hd} masked={m.masked} />
                  <div style={{ height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 700, color: "var(--gold)" }}>
                    <Flash v={m.masked ? "●●" : (m.ah?.text ?? "—")} />
                  </div>
                  <ArrowVal v={m.ah?.a} d={m.ah?.ad} masked={m.masked} />
                </div>
                <div style={{ background: "var(--inset)", borderRadius: 8, padding: "3px 0" }}>
                  <ArrowVal v={m.ou?.h} d={m.ou?.hd} masked={m.masked} />
                  <div className="mono" style={{ height: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--gold)" }}>
                    <Flash v={m.masked ? "●●" : m.ou?.line != null ? m.ou.line.toFixed(2) : "—"} />
                  </div>
                  <ArrowVal v={m.ou?.a} d={m.ou?.ad} masked={m.masked} />
                </div>
                <div style={{ background: "var(--inset)", borderRadius: 8, padding: "3px 0" }}>
                  {[m.eu?.h, m.eu?.d, m.eu?.a].map((v, i) => (
                    <div key={i} className="mono" style={{ height: i === 1 ? 16 : 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: i === 1 ? 11 : 12.5, fontWeight: i === 1 ? 700 : 600, color: i === 1 ? "var(--gold)" : undefined }}>
                      <Flash v={m.masked || v == null ? X : f2(v)} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <RefreshSheet open={rfOpen} onClose={() => setRfOpen(false)} activeIdx={null} />
    </div>
  );
}
