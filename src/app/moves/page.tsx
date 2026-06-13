"use client";

/** 指数异动监控:筛选 chips + 异动流 + 快照对比弹层;免注册前 3 条完整 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { Chip, GoldBtn, Sheet } from "@/components/ui";
import { leagueColor } from "@/lib/leagues";
import { useNewIds, useUnifiedPoll } from "@/components/live";
import { PageHeader } from "@/components/page-header";
import { SearchAction, type SearchItem } from "@/components/page-search";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";
import { MarketValue } from "@/components/market-cell";
import {
  MOVE_FILTERS,
  moveArrowStyle,
  moveCardStyle,
  moveNoteStyle,
  movePillStyle,
  moveTimeStyle,
  moveTitleStyle,
  moveTypeColor,
  moveTypeStyle,
  moveValueFromStyle,
  moveValueToStyle,
  moveWaterValueStyle,
} from "@/components/move-styles";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Move = any;

export default function MovesRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal /> : <MobileMovesPage />;
}

function MobileMovesPage() {
  const [filter, setFilter] = useState("全部");
  const [rows, setRows] = useState<Move[]>([]);
  const [searchRows, setSearchRows] = useState<Move[]>([]);
  const [loggedIn, setLoggedIn] = useState(true);
  const [sel, setSel] = useState<Move | null>(null);
  const { prefs } = useApp();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/moves?type=${encodeURIComponent(filter)}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setRows(j.rows);
        setLoggedIn(j.loggedIn);
        if (filter === "全部") setSearchRows(j.rows);
      }
      if (filter !== "全部") {
        const sr = await fetch(`/api/moves?type=${encodeURIComponent("全部")}&tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
        const sj = await sr.json();
        if (sj.ok) setSearchRows(sj.rows);
      }
    } catch {
      /* keep */
    } finally {
          }
  }, [filter, prefs.tz]);

  useEffect(() => {
    void load(); // 切筛选立即刷新
  }, [load]);
  const beat = useUnifiedPoll(load); // 四菜单统一节奏:有滚球 3s,否则 10s

  const freshIds = useNewIds(rows.map((r) => r.id));

  const searchItems = useMemo<SearchItem[]>(
    () =>
      searchRows.map((f) => ({
        id: f.id,
        title: f.match,
        subtitle: `${f.t} · ${f.mkFull ?? f.mk} · ${f.type}`,
        meta: [f.bk, f.note].filter(Boolean).join(" · "),
        badge: f.live ? "滚球" : f.sev ? "急变" : f.type,
        section: f.live ? "滚球异动" : "赛前异动",
        keywords: [f.fixtureId, f.match, f.league, f.mk, f.mkFull, f.bk, f.type, f.note, f.from, f.to, f.water, f.waterLabel],
        onSelect: () => (f.masked ? router.push("/login") : setSel(f)),
      })),
    [searchRows, router],
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader
        title="指数异动"
        {...beat}
        right={<SearchAction title="搜索异动" placeholder="球队 / 玩法 / 书商 / 水位 / 比赛 ID" hint={`${searchRows.length} 条可搜索`} scopeLabel="最近异动 · 全部类型" emptyText="没有匹配的异动记录" items={searchItems} />}
      />
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto", flexShrink: 0 }}>
        {MOVE_FILTERS.map((l) => (
          <Chip key={l} label={l} active={filter === l} onClick={() => setFilter(l)} />
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12.5, padding: "48px 0", lineHeight: 1.9 }}>
            暂无异动记录
            <br />
            <span style={{ fontSize: 11.5 }}>开盘后的指数/水位变化会实时进入这里</span>
          </div>
        )}
        {rows.map((f) => (
          <div
            key={f.id}
            className={freshIds.has(f.id) ? "feed-in" : undefined}
            onClick={() => (f.masked ? router.push("/login") : setSel(f))}
            style={moveCardStyle(false)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="mono" style={moveTimeStyle(false)}>{f.t}</span>
              <span style={moveTitleStyle(false)}>{f.match}</span>
              {f.sev && (
                <span style={movePillStyle("danger")}>急变</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {f.live && <span style={movePillStyle("live")}>滚球</span>}
              <span style={movePillStyle("neutral")}>{f.mk}</span>
              {f.bk && <span style={movePillStyle("muted")}>{f.bk}</span>}
              <span style={moveTypeStyle(f.type, false, f.direction)}>{f.type}</span>
              <MarketValue v={f.masked ? "●●" : f.from} className="" small dim={!!f.masked} style={moveValueFromStyle} />
              <span style={moveArrowStyle(f.type, false, f.direction)}>→</span>
              <MarketValue v={f.masked ? "●●" : f.to} className="" small dim={!!f.masked} style={f.masked ? moveValueFromStyle : moveValueToStyle(f.type, f.direction)} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
              <MarketValue v={f.masked ? "●●" : f.water} small dim={!!f.masked} style={f.masked ? { justifyContent: "flex-start" } : moveWaterValueStyle(f.waterDirection)} />
              <span style={moveNoteStyle(false)}>{f.note}</span>
            </div>
          </div>
        ))}
        {!loggedIn && rows.length > 0 && (
          <div
            onClick={() => router.push("/login")}
            style={{ background: "var(--card)", border: "1px solid var(--selected-border)", borderRadius: 12, padding: 14, textAlign: "center", cursor: "pointer" }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>登录后查看全部异动</div>
            <div style={{ fontSize: 11.5, color: "var(--fg-2)" }}>登录后查看完整异动流 · 新账号含基础报告额度</div>
          </div>
        )}
      </div>

      <Sheet open={!!sel} onClose={() => setSel(null)}>
        {sel && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(sel.leagueId) }} />
              <span style={{ fontSize: 11.5, color: "var(--fg-2)", fontWeight: 650 }}>{sel.league}</span>
              <span style={{ flex: 1 }} />
              {sel.sev && (
                <span style={movePillStyle("danger")}>急变</span>
              )}
            </div>
            <div style={{ fontSize: 16, fontWeight: 850, marginBottom: 10, color: "var(--fg)" }}>{sel.match}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <span style={movePillStyle("neutral")}>{sel.mkFull}</span>
              <span style={movePillStyle("muted")}>{sel.bk}</span>
              <span style={moveTypeStyle(sel.type, false, sel.direction)}>{sel.type}</span>
            </div>
            <div style={{ background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
                <span />
                <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)", textAlign: "right" }}>{sel.t0} 快照</span>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--fg)", fontWeight: 750, textAlign: "right" }}>{sel.t} 快照</span>
              </div>
              {sel.rows.map((r: Move) => {
                const na = parseFloat(r.a), nb = parseFloat(r.b);
                const delta = typeof r.delta === "number" ? r.delta : nb - na;
                const bC =
                  r.k === "指数"
                    ? (r.chg ? moveTypeColor(sel.type, sel.direction) : "var(--fg)")
                    : !isNaN(delta) && delta !== 0
                      ? delta > 0
                        ? "var(--up)"
                        : "var(--down)"
                      : "var(--fg)";
                return (
                  <div key={r.k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "9px 12px", borderBottom: "1px solid var(--line-soft)", alignItems: "center" }}>
                    <span style={{ fontSize: 11.5, color: "var(--fg-2)", fontWeight: 650 }}>{r.k}</span>
                    <MarketValue v={r.a} small dim style={{ justifyContent: "flex-end" }} />
                    <MarketValue v={r.b} small style={{ justifyContent: "flex-end", color: bC, fontWeight: 800 }} />
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginBottom: 14, lineHeight: 1.5 }}>变化幅度:{sel.note}</div>
            <GoldBtn label="查看本场指数走势" onClick={() => router.push(`/match/${sel.fixtureId}`)} />
          </>
        )}
      </Sheet>
    </div>
  );
}
