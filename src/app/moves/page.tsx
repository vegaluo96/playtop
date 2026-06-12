"use client";

/** 盘口异动监控:筛选 chips + 异动流 + 快照对比弹层;免注册前 3 条完整 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { Chip, GoldBtn, Sheet } from "@/components/ui";
import { leagueColor } from "@/lib/leagues";
import { useNewIds, useUnifiedPoll } from "@/components/live";
import { PageHeader } from "@/components/page-header";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Move = any;

export default function MovesRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <Terminal /> : <MobileMovesPage />;
}

function MobileMovesPage() {
  const [filter, setFilter] = useState("全部");
  const [rows, setRows] = useState<Move[]>([]);
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

  const typeColor = (t: string) => (t === "升盘" ? "var(--up)" : t === "降盘" ? "var(--down)" : "var(--gold)");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader title="盘口异动" {...beat} />
      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto", flexShrink: 0 }}>
        {["全部", "滚球", "升盘", "降盘", "水位"].map((l) => (
          <Chip key={l} label={l} active={filter === l} onClick={() => setFilter(l)} />
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        {rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0", lineHeight: 2 }}>
            暂无异动记录
            <br />
            <span style={{ fontSize: 10 }}>开盘后的盘口/水位变化会实时进入这里</span>
          </div>
        )}
        {rows.map((f) => (
          <div
            key={f.id}
            className={freshIds.has(f.id) ? "feed-in" : undefined}
            onClick={() => (f.masked ? router.push("/login") : setSel(f))}
            style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, marginBottom: 8, padding: "10px 12px", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{f.t}</span>
              <span style={{ fontSize: 14, fontWeight: 700, flex: 1 }}>{f.match}</span>
              {f.sev && (
                <span style={{ fontSize: 9, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 4, padding: "2px 6px" }}>急变</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {f.live && <span style={{ fontSize: 9, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 4, padding: "2px 6px" }}>滚球</span>}
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "2px 7px" }}>{f.mk}</span>
              {f.bk && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--fg-3)", background: "var(--inset)", borderRadius: 4, padding: "2px 7px" }}>{f.bk}</span>}
              <span style={{ fontSize: 10, fontWeight: 800, color: typeColor(f.type) }}>{f.type}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-2)" }}>{f.from}</span>
              <span style={{ fontSize: 11, color: typeColor(f.type) }}>→</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: typeColor(f.type) }}>{f.to}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", whiteSpace: "nowrap", flexShrink: 0 }}>{f.water}</span>
              <span style={{ fontSize: 10, color: "var(--fg-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.note}</span>
            </div>
          </div>
        ))}
        {!loggedIn && rows.length > 0 && (
          <div
            onClick={() => router.push("/login")}
            style={{ background: "linear-gradient(180deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.4)", borderRadius: 12, padding: 14, textAlign: "center", cursor: "pointer" }}
          >
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 3 }}>注册后查看完整异动</div>
            <div style={{ fontSize: 10, color: "var(--fg-2)" }}>同步领取 58 积分,可解锁 1 场深度分析</div>
          </div>
        )}
      </div>

      <Sheet open={!!sel} onClose={() => setSel(null)}>
        {sel && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(sel.leagueId) }} />
              <span style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 600 }}>{sel.league}</span>
              <span style={{ flex: 1 }} />
              {sel.sev && (
                <span style={{ fontSize: 9, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 4, padding: "2px 6px" }}>急变</span>
              )}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>{sel.match}</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "3px 8px" }}>{sel.mkFull}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 4, padding: "3px 8px" }}>{sel.bk}</span>
              <span style={{ fontSize: 10, fontWeight: 800, borderRadius: 4, padding: "3px 8px", background: "var(--inset)", color: typeColor(sel.type) }}>{sel.type}</span>
            </div>
            <div style={{ background: "#0e1117", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
                <span />
                <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", textAlign: "right" }}>{sel.t0} 快照</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--gold)", textAlign: "right" }}>{sel.t} 快照</span>
              </div>
              {sel.rows.map((r: Move) => {
                const na = parseFloat(r.a), nb = parseFloat(r.b);
                const bC =
                  r.k === "盘口"
                    ? r.chg
                      ? typeColor(sel.type)
                      : "var(--fg)"
                    : !isNaN(na) && !isNaN(nb) && na !== nb
                      ? nb > na
                        ? "var(--up)"
                        : "var(--down)"
                      : "var(--fg)";
                return (
                  <div key={r.k} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "9px 12px", borderBottom: "1px solid var(--line-soft)", alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{r.k}</span>
                    <span className="mono" style={{ fontSize: 12.5, textAlign: "right", color: "var(--fg-2)" }}>{r.a}</span>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 800, textAlign: "right", color: bC }}>{r.b}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 14 }}>变化幅度:{sel.note}</div>
            <GoldBtn label="查看本场盘口走势" onClick={() => router.push(`/match/${sel.fixtureId}`)} />
          </>
        )}
      </Sheet>
    </div>
  );
}
