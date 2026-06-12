"use client";

/** 赛事列表(首页):日期/联赛筛选 + 三列等宽指数卡,免注册打码由服务端执行 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { AnnouncementBar } from "@/components/announcement-bar";
import { PageHeader } from "@/components/page-header";
import { SearchAction, type SearchItem } from "@/components/page-search";
import { RiskFooter } from "@/components/consent-bar";
import { TeamLogo } from "@/components/img";
import { useSiteConfig } from "@/components/site-config";
import { Chip, Sheet } from "@/components/ui";
import { hhmm, parseTzOffset } from "@/lib/format";
import { LEAGUES, leagueColor, leagueZh } from "@/lib/leagues";
import { Flash, useUnifiedPoll } from "@/components/live";
import { MarketCell, type MarketCellData } from "@/components/market-cell";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";

type Cell = MarketCellData;
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
  homeId: number | null;
  awayId: number | null;
  homeLogo: string | null;
  awayLogo: string | null;
  moved: boolean;
  masked: boolean;
  free: boolean;
  unlocked: boolean;
  ah: Cell | null;
  ou: Cell | null;
  eu: Cell | null;
  ex: { ht: string | null; cor: string | null; red: string | null } | null;
}

interface DateOpt {
  k: string;
  label: string;
}

const WEEK = "日一二三四五六";

function shiftedDateLabel(offsetDays: number, tz: string): string {
  const off = parseTzOffset(tz);
  const d = new Date(Date.now() + off * 3_600_000 + offsetDays * 86_400_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} 周${WEEK[d.getUTCDay()]}`;
}

export default function MatchesRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal /> : <MobileMatchesPage />;
}

function MobileMatchesPage() {
  const [day, setDay] = useState("soon"); // 默认「即将」:滚球+未来24h,对齐球盘站
  const [league, setLeague] = useState("all");
  const [rows, setRows] = useState<Row[]>([]);
  const [liveCount, setLiveCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const { prefs } = useApp();
  const router = useRouter();
  // 联赛 chips:后台配置(含顺序)优先,静态表兜底
  const siteCfg = useSiteConfig();
  const leagueChips = siteCfg?.leagues ?? LEAGUES.map((l) => ({ id: l.id, zh: l.zh, color: l.color, on: true, wc: l.wc }));

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
    }
  }, [day, league, prefs.tz]);

  useEffect(() => {
    void load(); // 切日期/联赛立即刷新
  }, [load]);
  // 四菜单统一节奏:平台有滚球 3s(交易所级跳动,只渲染真实变化),否则 10s;后台 tab 暂停
  const beat = useUnifiedPoll(load);

  // 时间导航:常用状态直接露出;过去/未来日期收进弹层。
  const pastDays = Array.from({ length: 7 }, (_, i) => {
    const n = i + 1;
    return { k: `p${n}`, label: shiftedDateLabel(-n, prefs.tz) };
  });
  const futureDays = Array.from({ length: 12 }, (_, i) => {
    const n = i + 2;
    return { k: `d${n}`, label: shiftedDateLabel(n, prefs.tz) };
  });
  const pickedDate = [...pastDays, ...futureDays].find((d) => d.k === day);
  const dateChips = [
    { k: "live", label: `直播 ${liveCount}` },
    { k: "soon", label: "即将" },
    { k: "today", label: "今日" },
    { k: "results", label: "赛果" },
    { k: "tmr", label: "明日" },
  ];
  const emptyText = day === "soon"
    ? "未来 24 小时暂无即将开赛的场次"
    : day === "results" || day.startsWith("p")
      ? "该时段暂无已完场赛果"
      : "该时段暂无已开盘赛事";

  const renderRow = (m: Row) => {
    const exLine = m.ex ? [m.ex.ht ? `半场 ${m.ex.ht}` : null, m.ex.cor ? `角 ${m.ex.cor}` : null, m.ex.red ? `红 ${m.ex.red}` : null].filter(Boolean).join(" · ") : "";
    return (
      <div
        key={m.id}
        onClick={() => (m.masked ? router.push("/login") : router.push(`/match/${m.id}`))}
        style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, marginBottom: 8, padding: "9px 12px 10px", cursor: "pointer" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "start", marginBottom: 7 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, whiteSpace: "nowrap" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(m.leagueId), flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--fg-2)", fontWeight: 650, whiteSpace: "nowrap", flexShrink: 0 }}>{leagueZh(m.leagueId, m.leagueName)}</span>
              <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)", whiteSpace: "nowrap", flexShrink: 0 }}>{hhmm(m.kickoff, prefs.tz)}</span>
              {m.live && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--red)", fontWeight: 800, whiteSpace: "nowrap", flexShrink: 0 }}>
                  <span className="livepulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)", flexShrink: 0 }} />
                  {m.ht ? "中场" : m.elapsed != null ? `${m.elapsed}'` : "LIVE"}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0 }}>
            {exLine && <span className="mono" style={{ maxWidth: 150, fontSize: 11.5, color: "var(--fg-3)", fontWeight: 650, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{exLine}</span>}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 70px 70px 70px", gap: 8, alignItems: "center" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ height: 21, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: "var(--home)", background: "var(--team-home-bg)", borderRadius: 3, padding: "1px 5px" }}>主</span>
              <TeamLogo id={m.homeId} name={m.home} src={m.homeLogo} size={16} />
              <span style={{ fontSize: 15, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.home}</span>
            </div>
            <div className="mono" style={{ height: 16, display: "flex", alignItems: "center", fontSize: 11, color: m.live ? "var(--gold)" : m.finished ? "var(--fg)" : "var(--fg-4)", fontWeight: m.finished ? 800 : undefined, paddingLeft: 1, whiteSpace: "nowrap" }}>
              <Flash v={m.live || m.finished ? (m.score ?? "vs") : "vs"} />
            </div>
            <div style={{ height: 21, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: "var(--team-away)", background: "var(--team-away-bg)", borderRadius: 3, padding: "1px 5px" }}>客</span>
              <TeamLogo id={m.awayId} name={m.away} src={m.awayLogo} size={16} />
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.away}</span>
            </div>
          </div>
          <MarketCell kind="ah" cell={m.ah} masked={m.masked} />
          <MarketCell kind="ou" cell={m.ou} masked={m.masked} />
          <MarketCell kind="eu" cell={m.eu} masked={m.masked} />
        </div>
      </div>
    );
  };

  const searchItems = useMemo<SearchItem[]>(
    () =>
      rows.map((m) => {
        const leagueLabel = leagueZh(m.leagueId, m.leagueName);
        const markets = [
          m.ah ? `让球 ${m.ah.text}` : null,
          m.ou ? `大小 ${m.ou.text}` : null,
          m.eu ? "胜平负" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          id: m.id,
          title: `${m.home} vs ${m.away}`,
          subtitle: `${leagueLabel} · ${hhmm(m.kickoff, prefs.tz)}`,
          meta: markets || (m.live ? "滚球中" : "指数积累中"),
          badge: m.live ? "滚球" : m.free ? "免费报告" : undefined,
          keywords: [m.id, m.home, m.away, m.homeId, m.awayId, m.leagueName, leagueLabel, markets],
          onSelect: () => (m.masked ? router.push("/login") : router.push(`/match/${m.id}`)),
        };
      }),
    [rows, prefs.tz, router],
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <AnnouncementBar />
      <PageHeader
        title={<>足球<span style={{ color: "var(--gold)" }}>终端</span></>}
        {...beat}
        right={<SearchAction title="搜索赛事" placeholder="球队 / 联赛 / 比赛 ID" hint={`${rows.length} 场当前列表`} items={searchItems} />}
      />

      <div style={{ display: "flex", gap: 8, padding: "6px 16px 8px", flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 4, overflowX: "auto", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 12, padding: 3 }}>
          {dateChips.map((c) => {
            const active = day === c.k;
            return (
              <button
                key={c.k}
                type="button"
                onClick={() => setDay(c.k)}
                style={{ flexShrink: 0, height: 30, border: `1px solid ${active ? "var(--selected-border)" : "transparent"}`, borderRadius: 9, padding: "0 11px", background: active ? "var(--card)" : "transparent", color: active ? "var(--fg)" : "var(--fg-2)", fontSize: 12, fontWeight: active ? 800 : 650, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setDateOpen(true)}
          style={{ flexShrink: 0, height: 38, border: `1px solid ${pickedDate ? "var(--selected-border)" : "var(--line)"}`, borderRadius: 12, padding: "0 12px", background: pickedDate ? "var(--selected-bg)" : "var(--card)", color: pickedDate ? "var(--fg)" : "var(--fg-2)", fontSize: 12, fontWeight: 750, cursor: "pointer", whiteSpace: "nowrap" }}
        >
          {pickedDate ? `${pickedDate.label} ▾` : "日期 ▾"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto", flexShrink: 0 }}>
        <Chip label="全部" active={league === "all"} onClick={() => setLeague("all")} style={{ padding: "5px 12px", fontSize: 11 }} />
        {leagueChips.map((l) =>
          l.wc ? (
            <div
              key={l.id}
              onClick={() => setLeague(String(l.id))}
              className={league === String(l.id) ? "wcglow" : undefined}
              style={{
                position: "relative", overflow: "hidden", flexShrink: 0, padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 750, cursor: "pointer",
                background: league === String(l.id) ? "var(--selected-bg-strong)" : "var(--card)",
                color: league === String(l.id) ? "var(--gold)" : "var(--fg-2)",
                border: `1px solid ${league === String(l.id) ? "var(--selected-border-strong)" : "var(--selected-border-soft)"}`,
              }}
            >
              {league === String(l.id) && (
                <span className="wcsweep" style={{ position: "absolute", top: 0, left: 0, width: 36, height: "100%", background: "transparent" }} />
              )}
              <span style={{ position: "relative" }}>{l.zh}</span>
            </div>
          ) : (
            <Chip key={l.id} label={l.zh} active={league === String(l.id)} onClick={() => setLeague(String(l.id))} style={{ padding: "6px 12px", fontSize: 12 }} />
          ),
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 70px 70px 70px", gap: 8, padding: "4px 24px 7px 20px", alignItems: "center" }}>
        {["对阵", "让球", "大小", "胜平负"].map((h, i) => (
          <div key={h} style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 700, textAlign: i === 0 ? "left" : "center" }}>{h}</div>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {loaded && rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0" }}>{emptyText}</div>
        )}
        {rows.map(renderRow)}
        {loaded && <RiskFooter />}
      </div>
      <Sheet open={dateOpen} onClose={() => setDateOpen(false)}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>选择日期</span>
          <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>赛果与未来赛程</span>
        </div>
        {([
          ["过去 7 天", pastDays],
          ["未来 12 天", futureDays],
        ] as [string, DateOpt[]][]).map(([title, items]) => (
          <div key={title} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 800, margin: "0 0 7px 2px" }}>{title}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {items.map((d) => (
                <div
                  key={d.k}
                  onClick={() => {
                    setDay(d.k);
                    setDateOpen(false);
                  }}
                  style={{ textAlign: "center", padding: "10px 0", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", background: day === d.k ? "var(--selected-bg)" : "var(--inset)", color: day === d.k ? "var(--fg)" : "var(--fg-mid)", border: `1px solid ${day === d.k ? "var(--selected-border)" : "transparent"}` }}
                >
                  {d.label}
                </div>
              ))}
            </div>
          </div>
        ))}
      </Sheet>
    </div>
  );
}
