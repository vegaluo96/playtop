"use client";

/** 数据中心:积分榜 / 射手榜 / 助攻榜 / 赛程 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SearchAction, type SearchItem } from "@/components/page-search";
import { TeamLogo, PlayerAvatar } from "@/components/img";
import { EmptyBox } from "@/components/ui";
import { useApp } from "@/components/app-context";
import { useUnifiedPoll } from "@/components/live";
import { useSiteConfig } from "@/components/site-config";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";
import { LEAGUES, leagueColor } from "@/lib/leagues";

type TabKey = "standings" | "scorers" | "assists" | "schedule";

interface StandingRow {
  rank: number;
  teamId: number | null;
  team: string;
  logo: string | null;
  played: number;
  win: number;
  draw: number;
  lose: number;
  goals: string;
  diff: number;
  points: number;
  note: string;
  form: string;
}

interface PlayerRow {
  rank: number;
  playerId: number | null;
  player: string;
  photo: string | null;
  teamId: number | null;
  team: string;
  teamLogo: string | null;
  goals: number;
  assists: number;
  penalty: number;
}

interface ScheduleRow {
  id: number;
  round: string;
  date: string;
  time: string;
  live: boolean;
  finished: boolean;
  status: string;
  home: string;
  away: string;
  homeId: number | null;
  awayId: number | null;
  homeLogo: string | null;
  awayLogo: string | null;
  score: string;
}

interface DataView {
  ok: boolean;
  league: { id: number; zh: string; color: string; wc?: boolean };
  season: number;
  standings: { group: string; rows: StandingRow[] }[];
  scorers: PlayerRow[];
  assists: PlayerRow[];
  schedule: ScheduleRow[];
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "standings", label: "积分" },
  { key: "scorers", label: "射手" },
  { key: "assists", label: "助攻" },
  { key: "schedule", label: "赛程" },
];

export default function DataRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal /> : <MobileDataPage />;
}

function MobileDataPage() {
  const siteCfg = useSiteConfig();
  const router = useRouter();
  const { prefs } = useApp();
  const leagueTabs = useMemo(() => {
    const source = siteCfg?.leagues ?? LEAGUES.map((l) => ({ ...l, on: true }));
    return [...source].sort((a, b) => Number(Boolean(b.wc)) - Number(Boolean(a.wc)));
  }, [siteCfg]);
  const firstLeague = leagueTabs.find((l) => l.wc)?.id ?? leagueTabs[0]?.id ?? 1;
  const [league, setLeague] = useState(firstLeague);
  const [tab, setTab] = useState<TabKey>("standings");
  const [view, setView] = useState<DataView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (leagueTabs.length && !leagueTabs.some((l) => l.id === league)) setLeague(firstLeague);
  }, [leagueTabs, firstLeague, league]);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/data?league=${league}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setView(j);
    } catch {
      /* keep old view */
    } finally {
      setLoaded(true);
    }
  }, [league, prefs.tz]);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);
  useUnifiedPoll(load);

  const searchItems = useMemo<SearchItem[]>(() => {
    if (!view) return [];
    const standings = view.standings.flatMap((group) =>
      group.rows.map((r) => ({
        id: `st:${group.group}:${r.teamId ?? r.rank}`,
        title: r.team,
        subtitle: `${view.league.zh} · ${group.group}`,
        meta: `${r.points} 分 · ${r.win}胜${r.draw}平${r.lose}负`,
        badge: "积分",
        section: "积分榜",
        keywords: [r.team, r.points, r.goals, r.note, r.form],
      })),
    );
    const scorers = view.scorers.map((r) => ({
      id: `g:${r.playerId ?? r.rank}`,
      title: r.player,
      subtitle: r.team,
      meta: `${r.goals} 球${r.penalty ? ` · 点球 ${r.penalty}` : ""}`,
      badge: "射手",
      section: "射手榜",
      keywords: [r.player, r.team, r.goals, r.penalty],
    }));
    const assists = view.assists.map((r) => ({
      id: `a:${r.playerId ?? r.rank}`,
      title: r.player,
      subtitle: r.team,
      meta: `${r.assists} 助攻`,
      badge: "助攻",
      section: "助攻榜",
      keywords: [r.player, r.team, r.assists],
    }));
    const schedule = view.schedule.map((r) => ({
      id: `fx:${r.id}`,
      title: `${r.home} vs ${r.away}`,
      subtitle: `${r.date} ${r.time} · ${r.round}`,
      meta: `${r.score} · ${r.status}`,
      badge: r.live ? "进行中" : r.finished ? "赛果" : "赛程",
      section: "赛程",
      href: `/match/${r.id}`,
      keywords: [r.id, r.home, r.away, r.round, r.status, r.score],
    }));
    return [...standings, ...scorers, ...assists, ...schedule];
  }, [view]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader
        title="数据"
        right={<SearchAction title="搜索数据" placeholder="球队 / 球员 / 赛程 / 排名" hint={`${searchItems.length} 条可搜索`} scopeLabel={view ? `${view.league.zh} · ${view.season}` : "数据中心"} emptyText="没有匹配的数据" items={searchItems} />}
      />

      <div style={{ display: "flex", gap: 18, overflowX: "auto", padding: "0 16px 8px", flexShrink: 0 }}>
        {leagueTabs.map((l) => {
          const active = league === l.id;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => setLeague(l.id)}
              style={{ position: "relative", flexShrink: 0, border: 0, background: "transparent", color: active ? "var(--fg)" : "var(--fg-2)", padding: "4px 0 9px", fontSize: 15, fontWeight: active ? 850 : 750, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              {l.zh}
              <span style={{ position: "absolute", left: 0, right: 0, bottom: 1, height: 3, borderRadius: 3, background: active ? "var(--fg)" : "transparent" }} />
            </button>
          );
        })}
      </div>

      <div style={{ padding: "0 12px 10px", flexShrink: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 12, padding: 3 }}>
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                style={{ height: 32, border: `1px solid ${active ? "var(--selected-border)" : "transparent"}`, borderRadius: 9, background: active ? "var(--card)" : "transparent", color: active ? "var(--fg)" : "var(--fg-3)", fontSize: 12.5, fontWeight: active ? 850 : 750, cursor: "pointer" }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 16px 9px", flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: view?.league.color ?? leagueColor(league), flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: "var(--fg-2)", fontWeight: 750 }}>{view ? `${view.league.zh} · ${view.season}` : "数据加载中"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>官方返回数据</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {!loaded && <div style={{ padding: "48px 0", textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>加载中</div>}
        {loaded && view && tab === "standings" && <Standings groups={view.standings} />}
        {loaded && view && tab === "scorers" && <PlayerBoard rows={view.scorers} value="goals" />}
        {loaded && view && tab === "assists" && <PlayerBoard rows={view.assists} value="assists" />}
        {loaded && view && tab === "schedule" && <Schedule rows={view.schedule} onOpen={(id) => router.push(`/match/${id}`)} />}
      </div>
    </div>
  );
}

function Standings({ groups }: { groups: { group: string; rows: StandingRow[] }[] }) {
  if (groups.length === 0) return <EmptyBox title="积分榜暂无官方返回" sub="该赛事积分数据尚未公布或仍在归档积累中" />;
  return (
    <>
      {groups.map((group) => (
        <div key={group.group} style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--card)", marginBottom: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 28px 28px 28px 28px 54px 38px", gap: 8, alignItems: "center", padding: "9px 10px", background: "var(--inset)", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 12, fontWeight: 850 }}>{group.group}</span>
            {["场", "胜", "平", "负", "进/失", "积分"].map((h) => <span key={h} style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 800, textAlign: "center" }}>{h}</span>)}
          </div>
          {group.rows.map((r) => (
            <div key={`${group.group}:${r.rank}:${r.teamId ?? r.team}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 28px 28px 28px 28px 54px 38px", gap: 8, alignItems: "center", padding: "10px 10px", borderBottom: "1px solid var(--line-soft)" }}>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ width: 18, flexShrink: 0, fontSize: 12, color: "var(--fg-3)", fontWeight: 850 }}>{r.rank}</span>
                <TeamLogo id={r.teamId} src={r.logo} name={r.team} size={19} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 800 }}>{r.team}</span>
              </div>
              {[r.played, r.win, r.draw, r.lose].map((v, i) => <span key={i} className="mono" style={{ textAlign: "center", fontSize: 12.5, fontWeight: 750 }}>{v}</span>)}
              <span className="mono" style={{ textAlign: "center", fontSize: 12.5, color: "var(--fg-2)", fontWeight: 750 }}>{r.goals}</span>
              <span className="mono" style={{ textAlign: "center", fontSize: 13, fontWeight: 850 }}>{r.points}</span>
              {(r.note || r.form) && (
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 6, alignItems: "center", paddingLeft: 26, marginTop: -4 }}>
                  {r.note && <span style={{ fontSize: 10.5, color: "var(--fg-2)", background: "var(--selected-bg)", border: "1px solid var(--selected-border-soft)", borderRadius: 5, padding: "2px 6px" }}>{r.note}</span>}
                  {r.form && <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>近况 {r.form}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function PlayerBoard({ rows, value }: { rows: PlayerRow[]; value: "goals" | "assists" }) {
  if (rows.length === 0) return <EmptyBox title={`${value === "goals" ? "射手榜" : "助攻榜"}暂无官方返回`} sub="榜单数据尚未公布或样本仍在积累中" />;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--card)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(76px,0.55fr) 52px", gap: 8, padding: "9px 12px", background: "var(--inset)", borderBottom: "1px solid var(--line)" }}>
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 850 }}>球员</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 850 }}>球队</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 850, textAlign: "right" }}>{value === "goals" ? "进球" : "助攻"}</span>
      </div>
      {rows.map((r) => (
        <div key={`${value}:${r.rank}:${r.playerId ?? r.player}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(76px,0.55fr) 52px", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ width: 18, flexShrink: 0, fontSize: 12, color: "var(--fg-3)", fontWeight: 850 }}>{r.rank}</span>
            <PlayerAvatar id={r.playerId} name={r.player} size={26} />
            <span style={{ minWidth: 0, fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.player}</span>
          </div>
          <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
            <TeamLogo id={r.teamId} src={r.teamLogo} name={r.team} size={17} />
            <span style={{ minWidth: 0, fontSize: 12.5, color: "var(--fg-2)", fontWeight: 750, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.team}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <span className="mono" style={{ fontSize: 14, fontWeight: 900 }}>{value === "goals" ? r.goals : r.assists}</span>
            {value === "goals" && r.penalty > 0 && <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>点 {r.penalty}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Schedule({ rows, onOpen }: { rows: ScheduleRow[]; onOpen: (id: number) => void }) {
  if (rows.length === 0) return <EmptyBox title="赛程暂无官方返回" sub="该联赛赛程尚未入库或官方暂未公布" />;
  let lastRound = "";
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--card)" }}>
      {rows.map((r) => {
        const showRound = r.round !== lastRound;
        lastRound = r.round;
        return (
          <div key={r.id}>
            {showRound && <div style={{ padding: "8px 12px", background: "var(--inset)", borderBottom: "1px solid var(--line)", fontSize: 12, color: "var(--fg-2)", fontWeight: 850 }}>{r.round}</div>}
            <div onClick={() => onOpen(r.id)} style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr) 52px minmax(0,1fr)", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.35 }}>
                <div>{r.date}</div>
                <div>{r.time}</div>
              </div>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 800 }}>{r.home}</span>
                <TeamLogo id={r.homeId} src={r.homeLogo} name={r.home} size={18} />
              </div>
              <div className="mono" style={{ textAlign: "center", fontSize: 13, fontWeight: 900, color: r.live ? "var(--red)" : "var(--fg)", background: "var(--inset)", border: "1px solid var(--line-soft)", borderRadius: 7, padding: "5px 0" }}>{r.score}</div>
              <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <TeamLogo id={r.awayId} src={r.awayLogo} name={r.away} size={18} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 800 }}>{r.away}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
