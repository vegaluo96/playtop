"use client";

/**
 * 数据刷新规则弹层:档位表与 worker 调度同源(schedule.TIERS),频率取后台实际生效值
 * (/api/health intervals)。按「赛前 → 滚球 → 完场」分组成阶梯,越临近开球节点越亮;
 * 从详情页打开时高亮该场当前所处档位并标「当前」。
 */
import { LIVE_TIER, TIERS, tierFreqText } from "@/server/af/schedule";
import { useTierIntervals } from "./live";
import { Sheet } from "./ui";

/** 赛前档位由远及近的节点亮度(视觉传达「越近越快」) */
const DOT_ALPHA = [0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1];

/** 阶梯主体(移动 Sheet 与桌面 Modal 共用) */
export function RefreshRules({ activeIdx, intervals }: { activeIdx: number | null; intervals: number[] | null }) {
  const row = (idx: number, dot: React.ReactNode, label: string, freq: string) => {
    const active = activeIdx === idx;
    return (
      <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 9, background: active ? "rgba(233,185,73,.12)" : "transparent" }}>
        <span style={{ width: 14, display: "flex", justifyContent: "center", flexShrink: 0 }}>{dot}</span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: active ? "var(--gold)" : "var(--fg-mid)" }}>
          {label}
          {active && <span style={{ fontSize: 8.5, fontWeight: 800, color: "var(--gold)", border: "1px solid rgba(233,185,73,.5)", borderRadius: 4, padding: "1px 5px", marginLeft: 7, verticalAlign: 1 }}>当前</span>}
        </span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: active ? "var(--gold)" : "var(--fg-2)", whiteSpace: "nowrap" }}>{freq}</span>
      </div>
    );
  };
  const groupTitle = (t: string) => (
    <div style={{ fontSize: 9.5, fontWeight: 800, color: "var(--fg-3)", letterSpacing: 2, padding: "8px 12px 2px" }}>{t}</div>
  );

  return (
    <>
      {groupTitle("赛前")}
      <div style={{ position: "relative" }}>
        {/* 阶梯连线:节点由远及近渐亮 */}
        <span style={{ position: "absolute", left: 18, top: 14, bottom: 14, width: 1, background: "linear-gradient(180deg,rgba(233,185,73,.12),rgba(233,185,73,.55))" }} />
        {TIERS.filter((r) => r.idx < LIVE_TIER).map((r) =>
          row(
            r.idx,
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: `rgba(233,185,73,${DOT_ALPHA[r.idx] ?? 1})`, position: "relative" }} />,
            r.label,
            tierFreqText(r.idx, intervals?.[r.idx] ?? r.intervalMs),
          ),
        )}
      </div>

      {groupTitle("滚球")}
      {row(
        LIVE_TIER,
        <span className="livepulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--red)" }} />,
        TIERS[LIVE_TIER].label,
        tierFreqText(LIVE_TIER, intervals?.[LIVE_TIER] ?? TIERS[LIVE_TIER].intervalMs),
      )}

      {groupTitle("完场")}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
        <span style={{ width: 14, display: "flex", justifyContent: "center", flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: "var(--green)", fontWeight: 800 }}>✓</span>
        </span>
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--fg-mid)" }}>已完场</span>
        <span className="mono" style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-2)" }}>数据固化 · 不再刷新</span>
      </div>

      <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 8, lineHeight: 1.7, borderTop: "1px solid var(--line-soft)", paddingTop: 8 }}>
        赔率、赛况与阵容来自官方接口,平台按上表频率自动抓取归档;频率为后台当前生效配置,调整后此处实时同步。页头「Live · Ns」为本页面向服务器的轮询节奏,与抓取档位相互独立。
      </div>
    </>
  );
}

export function RefreshSheet({ open, onClose, activeIdx }: { open: boolean; onClose: () => void; activeIdx: number | null }) {
  const intervals = useTierIntervals(open);
  if (!open) return null;
  return (
    <Sheet open onClose={onClose}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>数据刷新规则</span>
        <span style={{ fontSize: 10, color: "var(--fg-3)" }}>越临近开球,刷新越快</span>
      </div>
      <RefreshRules activeIdx={activeIdx} intervals={intervals} />
    </Sheet>
  );
}
