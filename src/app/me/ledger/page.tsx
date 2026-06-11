"use client";

/** 充值 / 消费记录(二级页) */
import { useEffect, useState } from "react";
import { useApp } from "@/components/app-context";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";
import { useUnlockFlow } from "@/components/unlock-flow";
import { SubpageHeader } from "@/components/ui";
import { nowStr } from "@/lib/format";

interface Row {
  kind: string;
  delta: number;
  note: string;
  created_at: number;
}

export default function LedgerPageRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <Terminal initialDrawer /> : <MobileLedgerPage />;
}

function MobileLedgerPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { me } = useApp();
  const flow = useUnlockFlow();

  useEffect(() => {
    void fetch("/api/wallet")
      .then((r) => r.json())
      .then((j) => j.ok && setRows(j.ledger))
      .finally(() => setLoaded(true));
  }, [me.pts]);

  const fmtT = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  void nowStr;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <SubpageHeader title="充值 / 消费记录" />
      <div style={{ display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.3)", borderRadius: 12, margin: "6px 12px 4px", padding: "12px 14px" }}>
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: 10, color: "var(--fg-2)" }}>当前余额</span>
          <span className="mono" style={{ fontSize: 22, fontWeight: 800, color: "var(--gold)" }}>{me.pts}</span>
        </span>
        <div onClick={flow.openRecharge} style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 9, padding: "8px 18px", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>充值</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px 16px", minHeight: 0 }}>
        {loaded && rows.length === 0 && (
          <div style={{ textAlign: "center", color: "var(--fg-3)", fontSize: 12, padding: "48px 0", lineHeight: 2 }}>
            暂无记录
            <br />
            <span style={{ fontSize: 10 }}>充值或解锁比赛后将显示在这里</span>
          </div>
        )}
        {rows.length > 0 && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "2px 14px" }}>
            {rows.map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.note}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{fmtT(l.created_at)}</span>
                </span>
                <span className="mono" style={{ fontSize: 13, fontWeight: 800, color: l.delta >= 0 ? "var(--up)" : "var(--down)" }}>
                  {l.delta >= 0 ? `+${l.delta}` : l.delta}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {flow.ui}
    </div>
  );
}
