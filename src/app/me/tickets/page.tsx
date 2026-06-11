"use client";

/** 系统工单(二级页):类型 chips + 描述 + 我的工单列表 */
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/app-context";
import { Chip, EmptyBox, GoldBtn, SubpageHeader } from "@/components/ui";

interface Ticket {
  id: number;
  type: string;
  body: string;
  status: string;
  created_at: number;
}

const TYPES = ["数据问题", "充值问题", "功能建议", "其他"];

export default function TicketsPage() {
  const [type, setType] = useState(TYPES[0]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { me } = useApp();

  const load = useCallback(async () => {
    const j = await fetch("/api/tickets").then((r) => r.json());
    if (j.ok) setTickets(j.tickets);
  }, []);

  useEffect(() => {
    if (me.loggedIn) void load();
  }, [me.loggedIn, load]);

  const submit = async () => {
    const ta = document.getElementById("tk-desc") as HTMLTextAreaElement | null;
    const body = ta?.value.trim() ?? "";
    if (!body) {
      setMsg({ ok: false, text: "请先填写问题描述" });
      return;
    }
    const j = await fetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, body }),
    }).then((r) => r.json());
    if (j.ok) {
      if (ta) ta.value = "";
      setMsg({ ok: true, text: "已提交,客服将在 24 小时内通过站内消息回复" });
      void load();
    } else setMsg({ ok: false, text: j.error || "提交失败,请先登录" });
  };

  const fmtT = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <SubpageHeader title="系统工单" />
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 12px 16px", minHeight: 0 }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, padding: 14 }}>
          <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 8 }}>问题类型</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {TYPES.map((t) => (
              <Chip key={t} label={t} active={type === t} onClick={() => setType(t)} style={{ fontSize: 11.5, fontWeight: 700 }} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 8 }}>问题描述</div>
          <textarea
            id="tk-desc"
            rows={4}
            placeholder="请描述你遇到的问题或建议,如:某场比赛盘口数据延迟…"
            style={{ width: "100%", boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: 12, fontSize: 13, color: "var(--fg)", outline: "none", resize: "none", lineHeight: 1.6 }}
          />
          {msg && <div style={{ fontSize: 10, color: msg.ok ? "var(--up)" : "var(--red)", marginTop: 6, textAlign: msg.ok ? "center" : "left" }}>{msg.text}</div>}
          <GoldBtn label="提交工单" onClick={submit} style={{ marginTop: 12 }} />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "14px 4px 8px" }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>我的工单</div>
        </div>
        {tickets.length === 0 ? (
          <EmptyBox title="暂无工单记录" />
        ) : (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "2px 14px" }}>
            {tickets.map((t) => (
              <div key={t.id} style={{ padding: "11px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>T{t.id}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>{t.type}</span>
                  <span style={{ fontSize: 9, fontWeight: 800, borderRadius: 4, padding: "2px 7px", background: t.status === "处理中" ? "rgba(233,185,73,.14)" : "rgba(46,204,138,.14)", color: t.status === "处理中" ? "var(--gold)" : "#2ecc8a" }}>{t.status}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontSize: 11, color: "var(--fg-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.body}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)", flexShrink: 0 }}>{fmtT(t.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
