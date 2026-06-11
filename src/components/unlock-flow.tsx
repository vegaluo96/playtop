"use client";

/**
 * 解锁 + 充值复合弹层(全站唯一收费路径):
 * 余额够 → 确认解锁;不够 → 一键转充值弹层,充值完回到解锁。
 */
import { useState } from "react";
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

const TIERS: Tier[] = [
  { rmb: 6, pts: 60 },
  { rmb: 30, pts: 320, tag: "+6%" },
  { rmb: 68, pts: 750, tag: "+10%" },
  { rmb: 128, pts: 1480, tag: "+15%" },
  { rmb: 328, pts: 3940, tag: "+20%" },
  { rmb: 648, pts: 8420, tag: "+30%", hot: true },
];

export function useUnlockFlow(onUnlocked?: () => void) {
  const [target, setTarget] = useState<UnlockTarget | null>(null);
  const [sheet, setSheet] = useState<"unlock" | "recharge" | null>(null);
  const [busy, setBusy] = useState(false);
  const { me, refreshMe } = useApp();
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
      } else alert(j.error || "充值失败");
    } finally {
      setBusy(false);
    }
  };

  const ui = (
    <>
      <Sheet open={sheet === "unlock"} onClose={() => setSheet(null)} z={60}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 3 }}>解锁预测 · {target?.match}</div>
        <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 14, lineHeight: 1.6 }}>
          官方模型预测(建议 / 胜者 / 大小球方向)+ AI 分析报告
          <br />
          解锁后永久可见
        </div>
        <div style={{ display: "flex", background: "var(--inset)", borderRadius: 10, padding: "11px 14px", marginBottom: 14, justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
            价格 <span className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{target?.price}</span> 积分
          </span>
          <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
            余额{" "}
            <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: target && me.pts < target.price ? "var(--down)" : "var(--up)" }}>
              {me.pts}
            </span>{" "}
            积分
          </span>
        </div>
        <GoldBtn label={busy ? "处理中…" : target && me.pts < target.price ? "余额不足 · 去充值" : "确认解锁"} onClick={confirm} />
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)", marginTop: 8 }}>解锁后永久可见 · 开赛后价格上调至 58 积分</div>
      </Sheet>

      <Sheet open={sheet === "recharge"} onClose={() => setSheet(null)}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>充值积分</span>
          <span style={{ fontSize: 10, color: "var(--gold)", fontWeight: 700 }}>首充任意档位 +50%</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 14 }}>积分仅用于解锁比赛深度数据 · 1 元 = 10 积分起</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
          {TIERS.map((tr, i) => (
            <div
              key={tr.rmb}
              onClick={() => doRecharge(i)}
              style={{ position: "relative", background: "var(--inset)", border: `1px solid ${tr.hot ? "rgba(233,185,73,.55)" : "var(--line)"}`, borderRadius: 10, padding: "12px 0 10px", textAlign: "center", cursor: "pointer" }}
            >
              {tr.hot && (
                <span style={{ position: "absolute", top: -7, right: 8, background: "var(--gold)", color: "#0a0b0f", fontSize: 8, fontWeight: 800, borderRadius: 4, padding: "1px 5px" }}>最划算</span>
              )}
              <div className="mono" style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{tr.pts}</div>
              <div style={{ fontSize: 9, color: "var(--up)", fontWeight: 700, height: 13 }}>{tr.tag ?? ""}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>¥{tr.rmb}</div>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-3)" }}>演示环境:点击档位即模拟支付到账</div>
      </Sheet>
    </>
  );

  return { open, openRecharge: () => setSheet("recharge"), ui };
}
