"use client";

/** 数据中心:积分榜 / 射手榜 / 助攻榜 / 赛程 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SearchAction, type SearchItem } from "@/components/page-search";
import { TeamLogo, PlayerAvatar } from "@/components/img";
import { EmptyBox, Sheet, SheetTitle } from "@/components/ui";
import { PlayerSheet, type PlayerTarget } from "@/components/player-sheet";
import { useApp } from "@/components/app-context";
import { useUnifiedPoll } from "@/components/live";
import { useSiteConfig } from "@/components/site-config";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";
import { LEAGUES } from "@/lib/leagues";

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
  seasonSource: "cache" | "official" | "inferred";
  standings: { group: string; rows: StandingRow[] }[];
  scorers: PlayerRow[];
  assists: PlayerRow[];
  schedule: ScheduleRow[];
}

interface TeamFocus {
  group: string;
  teamId: number | null;
  team: string;
  logo: string | null;
  stats?: Partial<StandingRow>;
  matches: ScheduleRow[];
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
  const [teamFocus, setTeamFocus] = useState<TeamFocus | null>(null);
  const [player, setPlayer] = useState<PlayerTarget | null>(null);
  const [targetRound, setTargetRound] = useState<string | null>(null);

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

  const teamMatches = useCallback((teamId: number | null, teamName: string) => {
    if (!view) return [];
    return view.schedule.filter((m) => (teamId != null && (m.homeId === teamId || m.awayId === teamId)) || m.home === teamName || m.away === teamName);
  }, [view]);

  const openTeam = useCallback((group: string, row: StandingRow) => {
    setTeamFocus({ group, teamId: row.teamId, team: row.team, logo: row.logo, stats: row, matches: teamMatches(row.teamId, row.team) });
  }, [teamMatches]);

  const searchItems = useMemo<SearchItem[]>(() => {
    if (!view) return [];
    const groupItems = view.standings.map((group) => {
      const ids = new Set(group.rows.map((r) => r.teamId).filter((id): id is number => id != null));
      const teams = group.rows.map((r) => r.team);
      const matchCount = view.schedule.filter((m) => (m.homeId != null && ids.has(m.homeId)) || (m.awayId != null && ids.has(m.awayId)) || teams.includes(m.home) || teams.includes(m.away)).length;
      return {
        id: `grp:${group.group}`,
        title: group.group,
        subtitle: `${view.league.zh} · 积分榜`,
        meta: `${group.rows.length} 队 · ${matchCount} 场关联赛程`,
        badge: "小组",
        section: "积分榜",
        onSelect: () => setTab("standings"),
        keywords: [group.group, ...teams],
      };
    });
    const standings = view.standings.flatMap((group) =>
      group.rows.map((r) => ({
        id: `st:${group.group}:${r.teamId ?? r.rank}`,
        title: r.team,
        subtitle: `${view.league.zh} · ${group.group}`,
        meta: `${r.points} 分 · ${r.win}胜${r.draw}平${r.lose}负`,
        badge: "积分",
        section: "积分榜",
        onSelect: () => openTeam(group.group, r),
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
      onSelect: r.playerId ? () => setPlayer({ id: r.playerId!, name: r.player, season: view.season }) : undefined,
      keywords: [r.player, r.team, r.goals, r.penalty],
    }));
    const assists = view.assists.map((r) => ({
      id: `a:${r.playerId ?? r.rank}`,
      title: r.player,
      subtitle: r.team,
      meta: `${r.assists} 助攻`,
      badge: "助攻",
      section: "助攻榜",
      onSelect: r.playerId ? () => setPlayer({ id: r.playerId!, name: r.player, season: view.season }) : undefined,
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
    const roundItems = [...new Set(view.schedule.map((r) => r.round))].map((round) => {
      const roundRows = view.schedule.filter((r) => r.round === round);
      return {
        id: `round:${round}`,
        title: round,
        subtitle: `${view.league.zh} · 赛程`,
        meta: `${roundRows.length} 场`,
        badge: "轮次",
        section: "赛程",
        onSelect: () => {
          setTab("schedule");
          setTargetRound(round);
        },
        keywords: [round, ...roundRows.flatMap((r) => [r.home, r.away, r.date, r.time])],
      };
    });
    return [...groupItems, ...standings, ...scorers, ...assists, ...roundItems, ...schedule];
  }, [openTeam, view]);
  const activeTabLabel = TABS.find((t) => t.key === tab)?.label ?? "数据";
  const SEASON_SRC: Record<string, string> = { official: "官方", cache: "归档", inferred: "推断" };
  const dataScope = view ? `${view.league.zh} · ${view.season} 赛季(${SEASON_SRC[view.seasonSource] ?? "—"}) · ${activeTabLabel}` : "数据加载中";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader
        title="数据"
        subtitle={dataScope}
        right={<SearchAction title="搜索数据" placeholder="球队 / 球员 / 小组 / 轮次 / 赛程" hint={`${searchItems.length} 条可搜索`} scopeLabel={dataScope} emptyText="没有匹配的数据" examples={["球队", "球员", "小组", "赛程", "轮次"]} items={searchItems} />}
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

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {!loaded && <div style={{ padding: "48px 0", textAlign: "center", color: "var(--fg-3)", fontSize: 12 }}>加载中</div>}
        {loaded && view && tab === "standings" && <Standings groups={view.standings} onOpenTeam={openTeam} />}
        {loaded && view && tab === "scorers" && <PlayerBoard rows={view.scorers} value="goals" season={view.season} onOpenPlayer={setPlayer} onOpenTeam={(row) => setTeamFocus({ group: "球员所属球队", teamId: row.teamId, team: row.team, logo: row.teamLogo, matches: teamMatches(row.teamId, row.team) })} />}
        {loaded && view && tab === "assists" && <PlayerBoard rows={view.assists} value="assists" season={view.season} onOpenPlayer={setPlayer} onOpenTeam={(row) => setTeamFocus({ group: "球员所属球队", teamId: row.teamId, team: row.team, logo: row.teamLogo, matches: teamMatches(row.teamId, row.team) })} />}
        {loaded && view && tab === "schedule" && <Schedule rows={view.schedule} targetRound={targetRound} onOpen={(id) => router.push(`/match/${id}`)} />}
      </div>
      <TeamSheet focus={teamFocus} onClose={() => setTeamFocus(null)} onOpenMatch={(id) => router.push(`/match/${id}`)} />
      <PlayerSheet target={player} onClose={() => setPlayer(null)} />
    </div>
  );
}

function Standings({
  groups,
  onOpenTeam,
}: {
  groups: { group: string; rows: StandingRow[] }[];
  onOpenTeam: (group: string, row: StandingRow) => void;
}) {
  if (groups.length === 0) return <EmptyBox title="暂无积分数据" sub="该赛事积分仍在更新或尚未公布" />;
  return (
    <>
      {groups.map((group) => {
        return (
        <div key={group.group} style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--card)", marginBottom: 10 }}>
          <div style={{ padding: "10px 12px", background: "var(--inset)", borderBottom: "1px solid var(--line)", fontSize: 13, fontWeight: 900 }}>
            {group.group}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 28px 28px 28px 28px 54px 38px", gap: 8, alignItems: "center", padding: "8px 10px", background: "var(--card)", borderBottom: "1px solid var(--line-soft)" }}>
            <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 850 }}>球队</span>
            {["场", "胜", "平", "负", "进/失", "积分"].map((h) => <span key={h} style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 850, textAlign: "center" }}>{h}</span>)}
          </div>
          {group.rows.map((r) => (
            <div
              key={`${group.group}:${r.rank}:${r.teamId ?? r.team}`}
              onClick={() => onOpenTeam(group.group, r)}
              style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 28px 28px 28px 28px 54px 38px", gap: 8, alignItems: "center", padding: "10px 10px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}
            >
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
        );
      })}
    </>
  );
}

function PlayerBoard({
  rows,
  value,
  season,
  onOpenPlayer,
  onOpenTeam,
}: {
  rows: PlayerRow[];
  value: "goals" | "assists";
  season: number;
  onOpenPlayer: (target: PlayerTarget) => void;
  onOpenTeam: (row: PlayerRow) => void;
}) {
  if (rows.length === 0) return <EmptyBox title={`${value === "goals" ? "射手榜" : "助攻榜"}暂无数据`} sub="榜单尚未公布或样本仍在积累中" />;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--card)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(76px,0.55fr) 52px", gap: 8, padding: "9px 12px", background: "var(--inset)", borderBottom: "1px solid var(--line)" }}>
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 850 }}>球员</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 850 }}>球队</span>
        <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 850, textAlign: "right" }}>{value === "goals" ? "进球" : "助攻"}</span>
      </div>
      {rows.map((r) => (
        <div key={`${value}:${r.rank}:${r.playerId ?? r.player}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(76px,0.55fr) 52px", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div
            onClick={() => r.playerId && onOpenPlayer({ id: r.playerId, name: r.player, season })}
            style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8, cursor: r.playerId ? "pointer" : "default" }}
          >
            <span className="mono" style={{ width: 18, flexShrink: 0, fontSize: 12, color: "var(--fg-3)", fontWeight: 850 }}>{r.rank}</span>
            <PlayerAvatar id={r.playerId} name={r.player} size={26} />
            <span style={{ minWidth: 0, fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.player}</span>
          </div>
          <div onClick={() => onOpenTeam(r)} style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
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

function Schedule({ rows, targetRound, onOpen }: { rows: ScheduleRow[]; targetRound?: string | null; onOpen: (id: number) => void }) {
  const rounds = useMemo(() => {
    const map = new Map<string, ScheduleRow[]>();
    for (const row of rows) {
      const list = map.get(row.round) ?? [];
      list.push(row);
      map.set(row.round, list);
    }
    return [...map.entries()].map(([round, items]) => ({ round, rows: items }));
  }, [rows]);
  const [roundIndex, setRoundIndex] = useState(0);

  useEffect(() => {
    if (rounds.length === 0) return;
    if (targetRound) {
      const target = rounds.findIndex((r) => r.round === targetRound);
      if (target >= 0) {
        setRoundIndex(target);
        return;
      }
    }
    const next = rounds.findIndex((r) => r.rows.some((m) => m.live || !m.finished));
    setRoundIndex(next >= 0 ? next : Math.max(0, rounds.length - 1));
  }, [rounds, targetRound]);

  if (rows.length === 0) return <EmptyBox title="暂无赛程数据" sub="该联赛赛程尚未入库或暂未公布" />;
  const active = rounds[Math.min(roundIndex, rounds.length - 1)] ?? rounds[0];
  const canPrev = roundIndex > 0;
  const canNext = roundIndex < rounds.length - 1;
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--card)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "76px minmax(0,1fr) 76px", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--inset)", borderBottom: "1px solid var(--line)" }}>
        <RoundButton label="上一轮" disabled={!canPrev} onClick={() => setRoundIndex((i) => Math.max(0, i - 1))} />
        <div style={{ minWidth: 0, textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{active.round}</div>
          <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 2 }}>第 {roundIndex + 1} / {rounds.length} 轮 · {active.rows.length} 场</div>
        </div>
        <RoundButton label="下一轮" disabled={!canNext} onClick={() => setRoundIndex((i) => Math.min(rounds.length - 1, i + 1))} />
      </div>
      {active.rows.map((r) => (
        <div key={r.id} onClick={() => onOpen(r.id)} style={{ display: "grid", gridTemplateColumns: "48px minmax(0,1fr) 52px minmax(0,1fr)", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}>
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
      ))}
    </div>
  );
}

function RoundButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        height: 30,
        border: `1px solid ${disabled ? "var(--line-soft)" : "var(--line)"}`,
        borderRadius: 8,
        background: disabled ? "transparent" : "var(--card)",
        color: disabled ? "var(--fg-3)" : "var(--fg)",
        fontSize: 11.5,
        fontWeight: 850,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function TeamSheet({ focus, onClose, onOpenMatch }: { focus: TeamFocus | null; onClose: () => void; onOpenMatch: (id: number) => void }) {
  return (
    <Sheet open={!!focus} onClose={onClose} z={78} maxHeight="min(76vh, 640px)">
      {focus && (
        <>
          <SheetTitle title={focus.team} hint={focus.group} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <TeamLogo id={focus.teamId} src={focus.logo} name={focus.team} size={42} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 850 }}>{focus.team}</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3 }}>
                {focus.stats?.rank ? `第 ${focus.stats.rank} 名 · ${focus.stats.points ?? 0} 分` : "球队赛程与关联数据"}
              </div>
            </div>
          </div>

          {focus.stats?.played != null && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginBottom: 12 }}>
              <TeamMetric label="场" value={focus.stats.played ?? 0} />
              <TeamMetric label="胜/平/负" value={`${focus.stats.win ?? 0}/${focus.stats.draw ?? 0}/${focus.stats.lose ?? 0}`} />
              <TeamMetric label="进/失" value={focus.stats.goals ?? "—"} />
              <TeamMetric label="积分" value={focus.stats.points ?? 0} />
            </div>
          )}

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "8px 0" }}>
            <span style={{ fontSize: 13, fontWeight: 900 }}>关联赛程</span>
            <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{focus.matches.length} 场</span>
          </div>
          {focus.matches.length === 0 && <EmptyBox title="暂无关联赛程" sub="当前缓存中还没有该队赛程" />}
          {focus.matches.slice(0, 12).map((m) => (
            <button
              key={`team:${m.id}`}
              type="button"
              onClick={() => {
                onClose();
                onOpenMatch(m.id);
              }}
              style={{ width: "100%", display: "grid", gridTemplateColumns: "48px minmax(0,1fr) 44px minmax(0,1fr)", gap: 7, alignItems: "center", border: "1px solid var(--line-soft)", borderRadius: 9, background: "var(--card)", color: "var(--fg)", padding: "8px 9px", marginBottom: 6, cursor: "pointer" }}
            >
              <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)", textAlign: "left", lineHeight: 1.35 }}>{m.date}<br />{m.time}</span>
              <span style={{ minWidth: 0, fontSize: 12.5, fontWeight: 800, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.home}</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 900, color: m.live ? "var(--red)" : "var(--fg-2)", textAlign: "center" }}>{m.score}</span>
              <span style={{ minWidth: 0, fontSize: 12.5, fontWeight: 800, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.away}</span>
            </button>
          ))}
        </>
      )}
    </Sheet>
  );
}

function TeamMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: "var(--inset)", border: "1px solid var(--line-soft)", borderRadius: 9, padding: "8px 4px", textAlign: "center" }}>
      <div className="mono" style={{ fontSize: 13, fontWeight: 900 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", marginTop: 3 }}>{label}</div>
    </div>
  );
}
