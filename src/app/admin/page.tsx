"use client";

/** 管理后台(admin.zsky.com / /admin):顶栏 + 10 模块侧栏 + 登录门 */
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/components/app-context";
import { DashView } from "@/components/admin/dash";
import { MatchesView, MktView, OrdersView, UsersView } from "@/components/admin/ops";
import { DataMonView, RiskView, SettingsView, TicketsView } from "@/components/admin/sys";
import { ReportsView } from "@/components/admin/reports";
import { useNow, agoText } from "@/components/live";
import { AdminDialogHost } from "@/components/admin/dialogs";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NAVS: [string, string][] = [
  ["dash", "运营看板"], ["user", "用户管理"], ["order", "订单与额度"], ["match", "赛事与内容"],
  ["mkt", "营销配置"], ["risk", "风控与审计"], ["ticket", "工单处理"], ["data", "数据与模型监控"],
  ["reports", "分析报告管理"], ["cfg", "系统设置"],
];

export default function AdminPage() {
  const [me, setMe] = useState<{ email: string; role: string } | null | undefined>(undefined);
  const [view, setView] = useState("dash");
  const [openTickets, setOpenTickets] = useState(0);
  const [workerAt, setWorkerAt] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const { prefs, setPrefs } = useApp();
  const now = useNow(5000);

  const check = useCallback(async () => {
    const r = await fetch("/api/admin/me", { cache: "no-store" });
    if (r.ok) setMe((await r.json()) as { email: string; role: string });
    else setMe(null);
  }, []);
  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    if (!me) return;
    const load = () => {
      void fetch("/api/admin/tickets?f=处理中").then((r) => r.json()).then((j) => j.ok && setOpenTickets(j.rows.length)).catch(() => {});
      void fetch("/api/health").then((r) => r.json()).then((j) => setWorkerAt(j.workerAt)).catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [me]);

  const login = async () => {
    setErr("");
    const email = (document.getElementById("ad-email") as HTMLInputElement).value;
    const password = (document.getElementById("ad-pass") as HTMLInputElement).value;
    const j = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }).then((r) => r.json());
    if (!j.ok) return setErr(j.error || "登录失败");
    await check();
    const a = await fetch("/api/admin/me", { cache: "no-store" });
    if (!a.ok) setErr("该账号不是管理员");
  };

  if (me === undefined) return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-3)", fontSize: 12 }}>加载中…</div>;

  if (!me)
    return (
      <div className="desktop-root" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <div style={{ width: 380 }}>
          <div style={{ textAlign: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 24, fontWeight: 800 }}>足球<span style={{ color: "var(--gold)" }}>终端</span></span>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--home)", border: "1px solid var(--info-border)", borderRadius: 4, padding: "2px 7px", marginLeft: 8 }}>管理后台</span>
          </div>
          <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)", marginBottom: 20 }}>仅管理员账号可进入 · 操作全程审计</div>
          <input id="ad-email" type="email" placeholder="管理员邮箱" style={{ width: "100%", boxSizing: "border-box", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", fontSize: 13, color: "var(--fg)", outline: "none", marginBottom: 10 }} />
          <input id="ad-pass" type="password" placeholder="密码" onKeyDown={(e) => e.key === "Enter" && void login()} style={{ width: "100%", boxSizing: "border-box", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", fontSize: 13, color: "var(--fg)", outline: "none", marginBottom: 12 }} />
          {err && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 10 }}>{err}</div>}
          <div onClick={() => void login()} style={{ background: "var(--cta)", color: "var(--on-cta)", borderRadius: 10, textAlign: "center", padding: "12px 0", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>登录后台</div>
        </div>
      </div>
    );

  const workerOk = workerAt != null && now - workerAt < 3 * 60_000;
  const views: Record<string, React.ReactNode> = {
    dash: <DashView />, user: <UsersView />, order: <OrdersView />, match: <MatchesView />, mkt: <MktView />,
    risk: <RiskView />, ticket: <TicketsView />, data: <DataMonView />, reports: <ReportsView />, cfg: <SettingsView />,
  };

  return (
    <div className="desktop-root" style={{ width: "100%", height: "100%", minWidth: 1180, display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--fg)", overflow: "hidden", overflowX: "auto" }}>
      <div style={{ flexShrink: 0, height: 52, display: "flex", alignItems: "center", gap: 14, padding: "0 20px", borderBottom: "1px solid var(--line)", background: "var(--card)" }}>
        <span style={{ fontSize: 17, fontWeight: 800 }}>足球<span style={{ color: "var(--gold)" }}>终端</span></span>
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--home)", border: "1px solid var(--info-border)", borderRadius: 4, padding: "2px 7px" }}>管理后台</span>
        <span style={{ flex: 1 }} />
        <span
          onClick={() => setPrefs({ theme: prefs.theme === "深色" ? "浅色" : "深色" })}
          style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", border: "1px solid var(--line)", borderRadius: 8, padding: "4px 12px", cursor: "pointer" }}
        >
          {prefs.theme === "深色" ? "☀ 浅色模式" : "☾ 深色模式"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: workerOk ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
          <span className={workerOk ? "livepulse" : undefined} style={{ width: 5, height: 5, borderRadius: "50%", background: workerOk ? "var(--green)" : "var(--red)" }} />
          {workerOk ? "调度运行中" : `调度离线(${agoText(workerAt, now)})`}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)" }}>{me.email}</span>
      </div>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", minHeight: 0 }}>
        <div style={{ borderRight: "1px solid var(--line)", background: "var(--bg)", padding: "12px 10px" }}>
          {NAVS.map(([k, label]) => (
            <div
              key={k}
              onClick={() => setView(k)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 9, cursor: "pointer", marginBottom: 4, background: view === k ? "var(--selected-bg)" : "transparent", color: view === k ? "var(--gold)" : "var(--fg-2)" }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
              <span style={{ flex: 1 }} />
              {k === "ticket" && openTickets > 0 && (
                <span style={{ fontSize: 11, fontWeight: 800, background: "var(--danger-bg)", color: "var(--red)", borderRadius: 8, padding: "1px 6px" }}>{openTickets}</span>
              )}
            </div>
          ))}
        </div>
        <div style={{ overflowY: "auto", minHeight: 0, padding: "16px 22px 24px" }}>{views[view]}</div>
      </div>
      <AdminDialogHost />
    </div>
  );
}
