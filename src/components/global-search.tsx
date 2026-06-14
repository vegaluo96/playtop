"use client";

/**
 * 全局统一搜索弹窗(全站共用):一个入口同时搜「比赛 / 联赛 / 球员」。
 * 与旧的「逐页只搜本页已加载数据」不同 —— 输入防抖后调 /api/search 全库检索,
 * 命中按三组展示:比赛 → 详情页;联赛 → 数据中心该联赛;球员 → 球员资料弹层。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet, SheetTitle } from "./ui";
import { SearchIcon } from "./page-search";
import { PlayerSheet, type PlayerTarget } from "./player-sheet";
import { useApp } from "./app-context";

interface MatchHit { id: number; home: string; away: string; league: string; time: string; live: boolean; finished: boolean }
interface LeagueHit { id: number; zh: string }
interface PlayerHit { id: number; name: string; team: string; league: string; season: number }
interface SearchResp { ok: boolean; matches: MatchHit[]; leagues: LeagueHit[]; players: PlayerHit[] }

const EMPTY: SearchResp = { ok: true, matches: [], leagues: [], players: [] };
const EXAMPLES = ["球队", "联赛", "球员", "比赛 ID"];

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchResp>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [player, setPlayer] = useState<PlayerTarget | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const { prefs } = useApp();

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [open]);

  // 输入防抖 → /api/search;切换查询时中断上一请求,避免乱序覆盖
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setData(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(query)}&tz=${encodeURIComponent(prefs.tz)}`, { signal: ctrl.signal, cache: "no-store" });
        const j = (await r.json()) as SearchResp;
        if (j.ok) setData(j);
      } catch {
        /* 中断或网络异常:保留上一结果 */
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, prefs.tz]);

  const close = () => {
    setOpen(false);
    setQ("");
    setData(EMPTY);
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };
  const openPlayer = (p: PlayerHit) => {
    close();
    setPlayer({ id: p.id, name: p.name, season: p.season });
  };

  const total = data.matches.length + data.leagues.length + data.players.length;
  const typed = q.trim().length > 0;

  return (
    <>
      <button
        type="button"
        aria-label="全局搜索"
        title="搜索 比赛 / 联赛 / 球员"
        onClick={() => setOpen(true)}
        style={{
          width: 38, height: 38, border: "1px solid var(--line)", borderRadius: 999,
          background: "var(--card)", color: "var(--fg)", display: "inline-flex",
          alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
        }}
      >
        <SearchIcon />
      </button>

      <Sheet open={open} onClose={close} z={70} maxHeight="min(80vh, 700px)" contentStyle={{ display: "flex", flexDirection: "column" }}>
        <SheetTitle title="搜索" hint="比赛 · 联赛 · 球员 · 全站统一" />
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 11px", marginBottom: 8 }}>
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="球队 / 联赛 / 球员 / 比赛 ID"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", color: "var(--fg)", fontSize: 13, fontWeight: 700 }}
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="清空搜索" style={{ border: 0, background: "transparent", color: "var(--fg-3)", fontSize: 18, lineHeight: 1, cursor: "pointer", padding: 0 }}>
              ×
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--fg-3)", whiteSpace: "nowrap" }}>全站 · 比赛 / 联赛 / 球员</span>
          {typed && (
            <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)", whiteSpace: "nowrap" }}>{loading ? "搜索中…" : `${total} 条`}</span>
          )}
        </div>

        {!typed && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 9, marginBottom: 3 }}>
            {EXAMPLES.map((x) => (
              <span key={x} style={{ flexShrink: 0, fontSize: 11, color: "var(--fg-2)", background: "var(--card)", border: "1px solid var(--line-soft)", borderRadius: 999, padding: "4px 8px", whiteSpace: "nowrap" }}>{x}</span>
            ))}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 2 }}>
          {!typed && (
            <div style={{ color: "var(--fg-3)", fontSize: 12, textAlign: "center", padding: "28px 8px", lineHeight: 1.7 }}>
              输入球队、联赛或球员名,跨全站检索<br />支持比赛 ID 直达
            </div>
          )}
          {typed && !loading && total === 0 && (
            <div style={{ color: "var(--fg-3)", fontSize: 12, textAlign: "center", padding: "28px 8px" }}>没有匹配的比赛 / 联赛 / 球员</div>
          )}

          {data.matches.length > 0 && (
            <Group label="比赛">
              {data.matches.map((m) => (
                <Row
                  key={`m:${m.id}`}
                  title={`${m.home} vs ${m.away}`}
                  sub={`${m.league} · ${m.time}`}
                  badge={m.live ? "滚球" : m.finished ? "完场" : "赛前"}
                  badgeColor={m.live ? "var(--red)" : undefined}
                  onClick={() => go(`/match/${m.id}`)}
                />
              ))}
            </Group>
          )}

          {data.leagues.length > 0 && (
            <Group label="联赛">
              {data.leagues.map((l) => (
                <Row key={`l:${l.id}`} title={l.zh} sub="数据中心 · 积分 / 射手 / 赛程" badge="联赛" onClick={() => go(`/data?league=${l.id}`)} />
              ))}
            </Group>
          )}

          {data.players.length > 0 && (
            <Group label="球员">
              {data.players.map((p) => (
                <Row key={`p:${p.id}`} title={p.name} sub={[p.team, p.league].filter(Boolean).join(" · ") || "球员资料"} badge="球员" onClick={() => openPlayer(p)} />
              ))}
            </Group>
          )}
        </div>
      </Sheet>

      <PlayerSheet target={player} onClose={() => setPlayer(null)} />
    </>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10.5, color: "var(--fg-3)", fontWeight: 800, letterSpacing: 0.5, padding: "6px 2px 4px" }}>{label}</div>
      {children}
    </div>
  );
}

function Row({ title, sub, badge, badgeColor, onClick }: { title: string; sub: string; badge: string; badgeColor?: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
      </div>
      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: badgeColor ?? "var(--fg-2)", background: "var(--inset)", border: "1px solid var(--line-soft)", borderRadius: 5, padding: "3px 7px" }}>{badge}</span>
      <span style={{ color: "var(--fg-3)", fontSize: 15, flexShrink: 0 }}>›</span>
    </div>
  );
}
