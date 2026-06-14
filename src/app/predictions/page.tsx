"use client";

/** AI 报告 tab:历史回测横幅(详情弹层)+ 全部/已解锁筛选 + 轻量概率卡 → AI 报告 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/page-header";
import { GlobalSearch } from "@/components/global-search";
import { ProbBar } from "@/components/charts";
import { SourceBadge, CoverageStrip } from "@/components/source-trust";
import { useUnlockFlow } from "@/components/unlock-flow";
import { Chip, FeedState, LockIcon, Sheet } from "@/components/ui";
import { useUnifiedPoll } from "@/components/live";
import { leagueColor } from "@/lib/leagues";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";

import type { PredCard } from "@/app/api/predictions/route";
/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export default function PredictionsRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal /> : <MobilePredictionsPage />;
}

function MobilePredictionsPage() {
  const [cards, setCards] = useState<PredCard[]>([]);
  const [record, setRecord] = useState<V | null>(null);
  const [filter, setFilter] = useState("全部");
  const [recOpen, setRecOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const [loggedIn, setLoggedIn] = useState(true);
  const { prefs } = useApp();
  const router = useRouter();
  const flow = useUnlockFlow(() => void load());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/predictions?tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) {
        setCards(j.cards);
        setRecord(j.record);
        setLoggedIn(j.loggedIn);
      }
      setErr(false);
    } catch {
      setErr(true); // 保留已有数据,轮询自动重试
    } finally {
      setLoaded(true);
    }
  }, [prefs.tz]);

  const beat = useUnifiedPoll(load); // 四菜单统一节奏:有滚球 3s,否则 10s

  const unlockedCount = cards.filter((c) => !c.locked).length;
  const shown = filter === "已解锁" ? cards.filter((c) => !c.locked) : cards;
  const rate = record?.hitRate30 != null ? `${record.hitRate30}%` : "积累中";
  const yday = record && record.yesterday.total > 0 ? `${record.yesterday.hit}/${record.yesterday.total}` : "积累中";
  const streak = record?.streak ? `${record.streak} 连续命中` : "积累中";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader
        title="报告"
        {...beat}
        right={<GlobalSearch />}
      />
      <div style={{ display: "flex", gap: 8, padding: "0 12px 10px", flexShrink: 0 }}>
        {["全部", "已解锁"].map((l) => (
          <Chip key={l} label={l === "已解锁" ? `已解锁 ${unlockedCount}` : l} active={filter === l} onClick={() => setFilter(l)} />
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        <div
          onClick={() => setRecOpen(true)}
          style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--card)", border: "1px solid var(--selected-border)", borderRadius: 12, padding: "10px 14px", marginBottom: 10, cursor: "pointer" }}
        >
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[[rate, "近30天回测", undefined], [yday, "昨日回测", undefined], [streak, "回测状态", undefined]].map(([v, label, color]) => (
              <div key={label as string} style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: color as string | undefined }}>{v as string}</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 1 }}>{label as string}</div>
              </div>
            ))}
          </div>
          <div style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: "var(--fg-1)" }}>详情 ›</div>
        </div>

        {shown.length === 0 && (
          <FeedState
            loading={!loaded}
            error={err}
            emptyTitle={filter === "已解锁" ? "尚未解锁任何报告" : "今日概率报告尚未生成"}
            emptySub={filter === "已解锁" ? "切到「全部」查看可用场次,或用账户额度解锁任意场报告" : "比赛开盘或概率快照就绪后自动生成报告"}
          />
        )}

        {shown.map((p) => (
          <div
            key={p.id}
            onClick={() => router.push(`/report/${p.id}`)}
            style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, marginBottom: 10, padding: "11px 12px", cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(p.leagueId) }} />
              <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{p.match}</span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{p.league} {p.time}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 7px", flexShrink: 0 }}>摘要</span>
              <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1, color: p.locked || !p.summaryReady ? "var(--fg-3)" : "var(--fg-1)" }}>
                {p.locked ? "解锁后查看完整摘要" : p.advice ?? "概率快照积累中,方向待真实信号补齐"}
              </span>
            </div>
            <ProbBar pH={p.pH} pD={p.pD} pA={p.pA} empty={!p.probReady} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 9 }}>
              {[
                ["亚盘方向", p.ahText, { sourceKind: p.ahKind, derived: p.ahDerived }],
                ["大小方向", p.uoText, { sourceKind: p.ouKind, derived: p.ouDerived }],
                ["模型", p.goalsText, null],
              ].map(([label, val, sig]) => (
                <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 6px", textAlign: "center" }}>
                  <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 2 }}>{label as string}</div>
                  <div style={{ fontSize: 12, fontWeight: 800 }}>{(val as string) ?? (p.locked ? (loggedIn ? "解锁查看" : "登录查看") : "积累中")}</div>
                  {!p.locked && (sig as V)?.sourceKind && <SourceBadge signal={sig as V} style={{ marginTop: 3 }} />}
                </div>
              ))}
            </div>
            {!p.locked && p.sourceCoverage && <CoverageStrip coverage={p.sourceCoverage} style={{ marginBottom: 9 }} />}
            <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
              {p.comparisonReady ? "七维对比 · 近 5 场 · 查看完整报告 ›" : "七维对比积累中 · 查看完整报告 ›"}
            </div>
            {p.locked && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  flow.open({ id: p.id, match: p.match, price: p.price });
                }}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 8, background: "var(--selected-bg-soft)", border: "1px dashed var(--selected-border)", borderRadius: 8, padding: "9px 0", cursor: "pointer" }}
              >
                <LockIcon />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--fg-1)" }}>{p.lockText}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <Sheet open={recOpen} onClose={() => setRecOpen(false)}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>历史回测</span>
          <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>概率摘要对照赛果自动统计</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[[rate, "近30天回测", undefined], [yday, "昨日回测", undefined], [streak, "回测状态", undefined]].map(([v, label, color]) => (
            <div key={label as string} style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: color as string | undefined }}>{v as string}</div>
              <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 1 }}>{label as string}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {(record?.week ?? []).map((b: V, i: number) => {
            const pct = b.total > 0 ? b.hit / b.total : null;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{b.total > 0 ? `${b.hit}/${b.total}` : "—"}</span>
                <div style={{ width: "100%", height: 34, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ width: "100%", borderRadius: 3, background: pct == null ? "var(--line)" : pct >= 0.66 ? "var(--team-away)" : "var(--fg-3)", height: pct == null ? 4 : Math.max(8, Math.round(pct * 34)) }} />
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{b.date.slice(8)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", marginBottom: 5 }}>昨日报告复盘</div>
          {(record?.yesterdayRows ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "8px 0" }}>昨日暂无已结算报告</div>}
          {(record?.yesterdayRows ?? []).map((y: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{y.match}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-1)", flexShrink: 0 }}>{y.pick}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", width: 28, textAlign: "right", flexShrink: 0 }}>{y.score}</span>
              <span style={{ width: 16, textAlign: "center", fontSize: 12, fontWeight: 800, flexShrink: 0, color: y.hit ? "var(--team-away)" : "var(--home)" }}>{y.hit ? "✓" : "✗"}</span>
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 6 }}>历史概率摘要与赛果对照统计</div>
        </div>
      </Sheet>
      {flow.ui}
    </div>
  );
}
