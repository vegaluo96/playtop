"use client";

/** 预测 tab:战绩横幅(详情弹层)+ 全部/已解锁筛选 + 轻量预测卡 → AI 报告 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { ProbBar } from "@/components/charts";
import { useUnlockFlow } from "@/components/unlock-flow";
import { Chip, EmptyBox, LockIcon, Sheet } from "@/components/ui";
import { leagueColor } from "@/lib/leagues";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export default function PredictionsPage() {
  const [cards, setCards] = useState<V[]>([]);
  const [record, setRecord] = useState<V | null>(null);
  const [filter, setFilter] = useState("全部");
  const [recOpen, setRecOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      }
    } catch {
      /* keep */
    } finally {
      setLoaded(true);
    }
  }, [prefs.tz]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const unlockedCount = cards.filter((c) => !c.locked).length;
  const shown = filter === "已解锁" ? cards.filter((c) => !c.locked) : cards;
  const rate = record?.hitRate30 != null ? `${record.hitRate30}%` : "—";
  const yday = record ? `${record.yesterday.hit}/${record.yesterday.total}` : "—";
  const streak = record?.streak ? `${record.streak} 连红` : "—";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <div style={{ padding: "14px 16px 10px" }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>赛事预测</div>
        <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 1 }}>官方模型 · 覆盖今日全部赛事 · 唯一付费项</div>
      </div>
      <div style={{ display: "flex", gap: 8, padding: "0 12px 10px", flexShrink: 0 }}>
        {["全部", "已解锁"].map((l) => (
          <Chip key={l} label={l === "已解锁" ? `已解锁 ${unlockedCount}` : l} active={filter === l} onClick={() => setFilter(l)} />
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px", minHeight: 0 }}>
        <div
          onClick={() => setRecOpen(true)}
          style={{ display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.35)", borderRadius: 12, padding: "10px 14px", marginBottom: 10, cursor: "pointer" }}
        >
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[[rate, "近30天命中", "var(--gold)"], [yday, "昨日战绩", undefined], [streak, "当前状态", "var(--up)"]].map(([v, label, color]) => (
              <div key={label as string} style={{ textAlign: "center" }}>
                <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: color as string | undefined }}>{v as string}</div>
                <div style={{ fontSize: 9, color: "var(--fg-2)", marginTop: 1 }}>{label as string}</div>
              </div>
            ))}
          </div>
          <div style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: "var(--gold)" }}>详情 ›</div>
        </div>

        {loaded && shown.length === 0 && (
          <EmptyBox
            title={filter === "已解锁" ? "尚未解锁任何预测" : "今日预测尚未生成"}
            sub={filter === "已解锁" ? "切到「全部」看看今日免费场,或用积分解锁任意场次" : "比赛开盘后官方模型自动生成预测"}
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
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{p.league} {p.time}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>建议</span>
              <span style={{ fontSize: 12.5, fontWeight: 800, flex: 1, color: p.locked ? "var(--fg-3)" : "var(--gold)" }}>
                {p.locked ? "解锁后查看官方建议与方向" : p.advice}
              </span>
            </div>
            <ProbBar pH={p.pH} pD={p.pD} pA={p.pA} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 9 }}>
              {[["预测胜者", p.winnerText], ["大小球", p.uoText], ["进球上限", p.goalsText]].map(([label, val]) => (
                <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "7px 6px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "var(--fg-3)", marginBottom: 2 }}>{label as string}</div>
                  <div style={{ fontSize: 11, fontWeight: 800 }}>{(val as string) ?? "●●●"}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--fg-3)" }}>七维对比 · 近 5 场数据 · 完整分析见 AI 报告 ›</div>
            {p.locked && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  flow.open({ id: p.id, match: p.match, price: p.price });
                }}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 8, background: "rgba(233,185,73,.08)", border: "1px dashed rgba(233,185,73,.4)", borderRadius: 8, padding: "9px 0", cursor: "pointer" }}
              >
                <LockIcon />
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--gold)" }}>{p.lockText}</span>
              </div>
            )}
          </div>
        ))}
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-4)", padding: "4px 16px", lineHeight: 1.6 }}>
          预测由官方模型生成,仅供参考,不构成投注建议。
        </div>
      </div>

      <Sheet open={recOpen} onClose={() => setRecOpen(false)}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>模型战绩</span>
          <span style={{ fontSize: 10, color: "var(--fg-3)" }}>预测对照赛果自动统计</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
          {[[rate, "近30天命中", "var(--gold)"], [yday, "昨日战绩", undefined], [streak, "当前状态", "var(--up)"]].map(([v, label, color]) => (
            <div key={label as string} style={{ textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: color as string | undefined }}>{v as string}</div>
              <div style={{ fontSize: 9, color: "var(--fg-2)", marginTop: 1 }}>{label as string}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {(record?.week ?? []).map((b: V, i: number) => {
            const pct = b.total > 0 ? b.hit / b.total : null;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                <span className="mono" style={{ fontSize: 8, color: "var(--fg-2)" }}>{b.total > 0 ? `${b.hit}/${b.total}` : "—"}</span>
                <div style={{ width: "100%", height: 34, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ width: "100%", borderRadius: 3, background: pct == null ? "#383d47" : pct >= 0.66 ? "var(--gold)" : "#9a7b30", height: pct == null ? 4 : Math.max(8, Math.round(pct * 34)) }} />
                </div>
                <span className="mono" style={{ fontSize: 8, color: "var(--fg-3)" }}>{b.date.slice(8)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", marginBottom: 5 }}>昨日预测复盘</div>
          {(record?.yesterdayRows ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "8px 0" }}>昨日暂无已结算预测</div>}
          {(record?.yesterdayRows ?? []).map((y: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
              <span style={{ flex: 1, fontSize: 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{y.match}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", flexShrink: 0 }}>{y.pick}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", width: 28, textAlign: "right", flexShrink: 0 }}>{y.score}</span>
              <span style={{ width: 16, textAlign: "center", fontSize: 12, fontWeight: 800, flexShrink: 0, color: y.hit ? "var(--up)" : "var(--down)" }}>{y.hit ? "✓" : "✗"}</span>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "var(--fg-3)", marginTop: 6 }}>战绩为模型历史预测对照赛果的统计,不构成投注建议</div>
        </div>
      </Sheet>
      {flow.ui}
    </div>
  );
}
