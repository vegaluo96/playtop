"use client";

/**
 * 解锁 + 购买额度复合弹层(全站唯一收费路径):
 * 账户额度够 → 确认解锁;不够 → 一键转购买额度弹层,购买后回到解锁。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "./app-context";
import { GoldBtn, Sheet, SheetTitle } from "./ui";

export interface UnlockTarget {
  id: number;
  match: string;
  price: number;
}

interface Tier {
  rmb: number;
  pts: number;
  tag?: string;
  hot?: boolean;
}

/* 兜底初值;打开购买额度层时从 /api/wallet 拉后台生效档位 */
const FALLBACK_TIERS: Tier[] = [
  { rmb: 6, pts: 60 },
  { rmb: 30, pts: 320, tag: "+6%" },
  { rmb: 68, pts: 750, tag: "+10%" },
  { rmb: 128, pts: 1480, tag: "+15%" },
  { rmb: 328, pts: 3940, tag: "+20%" },
  { rmb: 648, pts: 8420, tag: "+30%", hot: true },
];

/** 报告额度档位与维护开关(后台实际生效值);open 置 true 时拉取 */
export function useRechargeTiers(open: boolean): { tiers: Tier[]; maintenance: boolean } {
  const [tiers, setTiers] = useState<Tier[]>(FALLBACK_TIERS);
  const [maintenance, setMaintenance] = useState(false);
  useEffect(() => {
    if (!open) return;
    fetch("/api/wallet")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.tiers) && j.tiers.length > 0) setTiers(j.tiers as Tier[]);
        setMaintenance(!!j.maintenance);
      })
      .catch(() => {});
  }, [open]);
  return { tiers, maintenance };
}

export function useUnlockFlow(onUnlocked?: () => void) {
  const [target, setTarget] = useState<UnlockTarget | null>(null);
  const [sheet, setSheet] = useState<"unlock" | "recharge" | null>(null);
  const [busy, setBusy] = useState(false);
  const { me, refreshMe } = useApp();
  const { tiers, maintenance } = useRechargeTiers(sheet === "recharge");
  const router = useRouter();

  const open = (t: UnlockTarget) => {
    if (!me.loggedIn) {
      router.push("/login");
      return;
    }
    setTarget(t);
    setSheet("unlock");
  };

  const confirm = async () => {
    if (!target || busy) return;
    if (me.pts < target.price) {
      setSheet("recharge");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixtureId: target.id }),
      });
      const j = await r.json();
      if (j.ok) {
        await refreshMe();
        setSheet(null);
        onUnlocked?.();
      } else if (j.error === "余额不足") {
        setSheet("recharge");
      } else {
        alert(j.error || "解锁失败");
        setSheet(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const doRecharge = async (idx: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/wallet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "recharge", tier: idx }),
      });
      const j = await r.json();
      if (j.ok) {
        await refreshMe();
        setSheet(target ? "unlock" : null);
      } else alert(j.error || "购买额度失败");
    } finally {
      setBusy(false);
    }
  };

  const ui = (
    <>
      <Sheet open={sheet === "unlock"} onClose={() => setSheet(null)} z={60}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 3 }}>解锁 AI 概率报告 · {target?.match}</div>
        <div style={{ fontSize: 12, color: "var(--fg-2)", marginBottom: 14, lineHeight: 1.6 }}>
          概率摘要、指数解读与人员情报
        </div>
        <div style={{ display: "flex", background: "var(--inset)", borderRadius: 10, padding: "11px 14px", marginBottom: 14, justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
            价格 <span className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{target?.price}</span> 额度
          </span>
          <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
            账户额度{" "}
            <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: target && me.pts < target.price ? "var(--down)" : "var(--up)" }}>
              {me.pts}
            </span>{" "}
          </span>
        </div>
        <GoldBtn label={busy ? "处理中…" : target && me.pts < target.price ? "额度不足 · 去购买" : "确认解锁"} onClick={confirm} />
        <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)", marginTop: 8 }}>赛前 38 / 滚球 58 · 可回看</div>
      </Sheet>

      <Sheet open={sheet === "recharge"} onClose={() => setSheet(null)}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>购买报告额度</span>
          <span style={{ fontSize: 11, color: "var(--gold)", fontWeight: 750 }}>首购任意档位 +50%</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-2)", marginBottom: 14 }}>报告额度仅用于解锁 AI 概率报告 · 1 元 = 10 额度起</div>
        {maintenance && (
          <div style={{ background: "rgba(0,200,5,.1)", border: "1px solid rgba(0,200,5,.4)", borderRadius: 10, padding: "14px 12px", marginBottom: 12, textAlign: "center", fontSize: 12, color: "var(--gold)", fontWeight: 700 }}>
            购买通道维护中,请稍后再试
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12, opacity: maintenance ? 0.35 : 1, pointerEvents: maintenance ? "none" : "auto" }}>
          {tiers.map((tr, i) => (
            <div
              key={tr.rmb}
              onClick={() => doRecharge(i)}
              style={{ position: "relative", background: "var(--inset)", border: `1px solid ${tr.hot ? "rgba(0,200,5,.55)" : "var(--line)"}`, borderRadius: 10, padding: "12px 0 10px", textAlign: "center", cursor: "pointer" }}
            >
              {tr.hot && (
                <span style={{ position: "absolute", top: -8, right: 8, background: "var(--gold)", color: "var(--on-accent)", fontSize: 11, fontWeight: 800, borderRadius: 4, padding: "1px 6px" }}>最划算</span>
              )}
              <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{tr.pts}</div>
              <div style={{ fontSize: 11.5, color: "var(--up)", fontWeight: 750, height: 15 }}>{tr.tag ?? ""}</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--fg-2)" }}>¥{tr.rmb}</div>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>演示环境:点击档位即模拟支付到账</div>
      </Sheet>
    </>
  );

  return { open, openRecharge: () => setSheet("recharge"), ui };
}
