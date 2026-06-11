"use client";

/** 数据刷新规则弹层(档位表与 worker 调度同源:schedule.TIERS) */
import { TIERS } from "@/server/af/schedule";
import { Sheet } from "./ui";

export function RefreshSheet({ open, onClose, activeIdx }: { open: boolean; onClose: () => void; activeIdx: number | null }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>数据刷新规则</span>
        <span style={{ fontSize: 10, color: "var(--fg-3)" }}>越临近开球,刷新越快</span>
      </div>
      {TIERS.map((r) => {
        const active = activeIdx === r.idx;
        return (
          <div
            key={r.idx}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, marginBottom: 4, background: active ? "rgba(233,185,73,.12)" : "#10141d" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: active ? "var(--gold)" : "var(--fg-4)" }} />
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: active ? "var(--gold)" : "var(--fg-mid)" }}>{r.label}</span>
            <span className="mono" style={{ fontSize: 11.5, fontWeight: 800, color: active ? "var(--gold)" : "var(--fg-2)" }}>{r.freq}</span>
          </div>
        );
      })}
      <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 8, lineHeight: 1.7 }}>
        赔率、赛况与阵容数据来自官方接口,平台按上表频率自动抓取;滚球期为接口允许的最高刷新频率。
      </div>
    </Sheet>
  );
}
