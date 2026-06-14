"use client";

/** 指数异动监控:筛选 chips + 异动流 + 快照对比弹层;免注册前 3 条完整 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { Chip, FeedState, GoldBtn, Sheet } from "@/components/ui";
import { leagueColor } from "@/lib/leagues";
import { useNewIds, useUnifiedPoll } from "@/components/live";
import { PageHeader } from "@/components/page-header";
import { GlobalSearch } from "@/components/global-search";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";
import { MarketValue } from "@/components/market-cell";
import {
  MOVE_FILTERS,
  moveArrowStyle,
  moveCardStyle,
  movePillStyle,
  moveTimeStyle,
  moveTitleStyle,
  moveTypeColor,
  moveTypeStyle,
  moveValueFromStyle,
  moveValueToStyle,
} from "@/components/move-styles";

import type { MoveRow } from "@/app/api/moves/route";
type Move = MoveRow;

export default function MovesRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal /> : <MobileMovesPage />;
}

function MobileMovesPage() {
  const [filter, setFilter] = useState("全部");
  const [rows, setRows] = useState<Move[]>([]);
  const [loggedIn, setLoggedIn] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
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
      }
      setErr(false);
    } catch {
      setErr(true); // 保留已有数据,轮询自动重试
    } finally {
      setLoaded(true);
    }
  }, [filter, prefs.tz]);

  useEffect(() => {
    void load(); // 切筛选立即刷新
  }, [load]);
  const beat = useUnifiedPoll(load); // 四菜单统一节奏:有滚球 3s,否则 10s

  const freshIds = useNewIds(rows.map((r) => r.id));

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader
        title="异动"
        {...beat}
        right={<GlobalSearch />}
      />
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto", flexShrink: 0 }}>
        {MOVE_FILTERS.map((l) => (
          <Chip key={l} label={l} active={filter === l} onClick={() => setFilter(l)} />
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {rows.length === 0 && (
          <FeedState loading={!loaded} error={err} emptyTitle="暂无异动记录" emptySub="开盘后的指数/水位变化会实时进入这里" />
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
            {/* 固定单行:左侧 滚球/盘口/类型/书商(可截断),右侧 from→to;不再因类型多/少一行,所有卡片等高 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1, overflow: "hidden" }}>
                {f.live && <span style={movePillStyle("live")}>滚球</span>}
                <span style={movePillStyle("neutral")}>{f.mk}</span>
                <span style={moveTypeStyle(f.type, false, f.direction)}>{f.type}</span>
                {f.bk && !f.live && <span style={movePillStyle("muted", false, 88)}>{f.bk}</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <MarketValue v={f.masked ? "●●" : f.from} className="" small dim={!!f.masked} style={moveValueFromStyle} />
                <span style={moveArrowStyle(f.type, false, f.direction)}>→</span>
                <MarketValue v={f.masked ? "●●" : f.to} className="" small dim={!!f.masked} style={f.masked ? moveValueFromStyle : moveValueToStyle(f.type, f.direction)} />
              </div>
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
              {sel.rows.map((r) => {
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
