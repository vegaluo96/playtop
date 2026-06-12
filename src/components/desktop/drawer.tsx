"use client";

/** 桌面账户抽屉(右滑 390px):账户额度/兑换/邀请/流水/偏好/工单/退出 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp, type Scheme } from "@/components/app-context";
import { LANGS, type Lang } from "@/lib/i18n";
import { LEAGUES } from "@/lib/leagues";
import type { DModal } from "./terminal";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

const TZS: [string, string][] = [
  ["UTC+8", "北京 UTC+8"], ["UTC+9", "首尔·东京 UTC+9"], ["UTC+7", "曼谷 UTC+7"], ["UTC+1", "伦敦 UTC+1"],
  ["UTC+2", "中欧 UTC+2"], ["UTC-4", "纽约 UTC-4"], ["UTC-7", "洛杉矶 UTC-7"], ["UTC+10", "悉尼 UTC+10"],
];
const TK_TYPES = ["数据问题", "购买额度问题", "功能建议", "其他"];

function ChipBtn({ label, active, onClick, flex }: { label: string; active: boolean; onClick: () => void; flex?: boolean }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: flex ? 1 : undefined, textAlign: "center", padding: flex ? "6px 0" : "4px 10px", borderRadius: flex ? 8 : 999,
        fontSize: 11.5, fontWeight: flex ? 700 : 600, cursor: "pointer",
        background: active ? "rgba(0,200,5,.14)" : "var(--inset)",
        color: active ? "var(--gold)" : "var(--fg-2)",
        border: `1px solid ${active ? "rgba(0,200,5,.45)" : "var(--line)"}`,
      }}
    >
      {label}
    </div>
  );
}

export function AccountDrawer({ onClose, openModal }: { onClose: () => void; openModal: (m: DModal) => void }) {
  const { prefs, setPrefs, me, refreshMe } = useApp();
  const router = useRouter();
  const [ledger, setLedger] = useState<V[]>([]);
  const [invite, setInvite] = useState<V | null>(null);
  const [tickets, setTickets] = useState<V[]>([]);
  const [rdMsg, setRdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ivCopied, setIvCopied] = useState(false);
  const [tkType, setTkType] = useState(TK_TYPES[0]);
  const [tkMsg, setTkMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [w, inv, tk] = await Promise.all([
      fetch("/api/wallet").then((r) => r.json()).catch(() => null),
      fetch("/api/invite").then((r) => r.json()).catch(() => null),
      fetch("/api/tickets").then((r) => r.json()).catch(() => null),
    ]);
    if (w?.ok) setLedger(w.ledger);
    if (inv?.ok) setInvite(inv);
    if (tk?.ok) setTickets(tk.tickets);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll, me.pts]);

  const redeem = async () => {
    const el = document.getElementById("rd2") as HTMLInputElement | null;
    const code = el?.value.trim() ?? "";
    if (!code) {
      setRdMsg({ ok: false, text: "请输入兑换码" });
      return;
    }
    const j = await fetch("/api/wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "redeem", code }),
    }).then((r) => r.json());
    if (j.ok) {
      if (el) el.value = "";
      setRdMsg({ ok: true, text: `兑换成功,${j.note} 额度已到账` });
      await refreshMe();
    } else setRdMsg({ ok: false, text: j.error });
  };

  const submitTicket = async () => {
    const ta = document.getElementById("tk2") as HTMLTextAreaElement | null;
    const body = ta?.value.trim() ?? "";
    if (!body) {
      setTkMsg({ ok: false, text: "请先填写问题描述" });
      return;
    }
    const j = await fetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: tkType, body }),
    }).then((r) => r.json());
    if (j.ok) {
      if (ta) ta.value = "";
      setTkMsg({ ok: true, text: "已提交,客服将在 24 小时内回复" });
      void loadAll();
    } else setTkMsg({ ok: false, text: j.error || "提交失败" });
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await refreshMe();
    onClose();
    router.push("/login");
  };

  const Block = ({ children }: { children: React.ReactNode }) => (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>{children}</div>
  );
  const Label = ({ text }: { text: string }) => <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 6 }}>{text}</div>;

  // 游客:抽屉只给注册引导
  if (!me.loggedIn) {
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: 55, display: "flex", justifyContent: "flex-end", background: "rgba(4,5,9,.6)" }}>
        <div onClick={onClose} style={{ flex: 1 }} />
        <div style={{ width: 390, background: "var(--card)", borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>账户中心</span>
            <span onClick={onClose} style={{ fontSize: 14, color: "var(--fg-3)", cursor: "pointer" }}>✕</span>
          </div>
          <div style={{ padding: "18px" }}>
            <div style={{ background: "var(--card)", border: "1px solid rgba(0,200,5,.4)", borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>
                创建账户
              </div>
            <div style={{ fontSize: 12, color: "var(--fg-2)", marginBottom: 10, lineHeight: 1.6 }}>登录后查看完整指数与异动 · 新账号含基础报告额度</div>
              <div onClick={() => router.push("/login")} style={{ background: "var(--gold)", color: "var(--on-accent)", borderRadius: 9, textAlign: "center", padding: "10px 0", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                邮箱登录 / 注册
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 55, display: "flex", justifyContent: "flex-end", background: "rgba(4,5,9,.6)" }}>
      <div onClick={onClose} style={{ flex: 1 }} />
      <div style={{ width: 390, background: "var(--card)", borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>账户中心</span>
          <span onClick={onClose} style={{ fontSize: 14, color: "var(--fg-3)", cursor: "pointer" }}>✕</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "14px 18px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-mid)" }}>{me.email}</span>
            <span onClick={logout} style={{ fontSize: 11, color: "var(--red)", fontWeight: 700, cursor: "pointer" }}>退出登录</span>
          </div>

          {/* 账户额度 + 兑换 */}
          <div style={{ background: "var(--card)", border: "1px solid rgba(0,200,5,.3)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginBottom: 12 }}>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--fg-2)", marginBottom: 3 }}>账户额度</span>
                <span className="mono" style={{ fontSize: 26, lineHeight: 1, fontWeight: 800, color: "var(--gold)" }}>{me.pts}</span>
              </span>
              <div onClick={() => openModal({ kind: "recharge" })} style={{ flexShrink: 0, width: 72, boxSizing: "border-box", background: "var(--gold)", color: "var(--on-accent)", borderRadius: 8, padding: "9px 0", textAlign: "center", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>购买额度</div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
              <input id="rd2" placeholder="输入兑换码,如 WC2026" className="mono" style={{ flex: 1, minWidth: 0, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 12px", fontSize: 12, color: "var(--fg)", outline: "none" }} />
              <div onClick={redeem} style={{ flexShrink: 0, width: 64, boxSizing: "border-box", border: "1px solid rgba(0,200,5,.5)", color: "var(--gold)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>兑换</div>
            </div>
            {rdMsg && <div style={{ fontSize: 11, marginTop: 6, color: rdMsg.ok ? "var(--up)" : "var(--red)" }}>{rdMsg.text}</div>}
          </div>

          {/* 邀请 */}
          <Block>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 800 }}>邀请好友 · 每人 +1 额度</span>
              <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>日10 · 周30 · 月100</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
              <span className="mono" style={{ flex: 1, fontSize: 11, fontWeight: 700, color: "var(--gold)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{invite?.url ?? "…"}</span>
              <div
                onClick={() => {
                  try {
                    void navigator.clipboard.writeText(`https://${invite?.url ?? ""}`);
                  } catch { /* ignore */ }
                  setIvCopied(true);
                }}
                  style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 800, color: "var(--gold)", cursor: "pointer" }}
              >
                复制
              </div>
            </div>
            {ivCopied && <div style={{ fontSize: 11.5, color: "var(--up)", marginBottom: 6 }}>邀请链接已复制</div>}
            {[["今日", invite?.day ?? 0, 10], ["本周", invite?.week ?? 0, 30], ["本月", invite?.month ?? 0, 100]].map(([label, n, cap]) => (
              <div key={label as string} style={{ display: "grid", gridTemplateColumns: "36px 1fr 52px", gap: 10, alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{label as string}</span>
                <div style={{ height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "var(--gold)", width: `${Math.min(100, ((n as number) / (cap as number)) * 100)}%` }} />
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right" }}>{n as number} / {cap as number}</span>
              </div>
            ))}
            <div onClick={() => openModal({ kind: "invlog" })} style={{ textAlign: "center", padding: "8px 0 2px", fontSize: 11, fontWeight: 700, color: "var(--gold)", cursor: "pointer", borderTop: "1px solid var(--line-soft)", marginTop: 4 }}>邀请记录 ›</div>
          </Block>

          {/* 流水 */}
          <Block>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800 }}>额度 / 解锁记录</span>
              {ledger.length > 6 && <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>共 {ledger.length} 笔 · 显示最近 6 笔</span>}
            </div>
            {ledger.length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)" }}>暂无记录</div>}
            {ledger.slice(0, 6).map((l, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--line-soft)" }}>
                <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{l.note}</span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: l.delta >= 0 ? "var(--up)" : "var(--down)" }}>{l.delta >= 0 ? `+${l.delta}` : l.delta}</span>
              </div>
            ))}
            {ledger.length > 6 && (
              <div onClick={() => openModal({ kind: "ledger" })} style={{ textAlign: "center", padding: "8px 0 2px", fontSize: 11, fontWeight: 700, color: "var(--gold)", cursor: "pointer", borderTop: "1px solid var(--line-soft)", marginTop: 4 }}>
                查看全部 {ledger.length} 笔历史记录 ›
              </div>
            )}
          </Block>

          {/* 偏好 */}
          <Block>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 10 }}>偏好设置</div>
            <Label text="关注联赛" />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {LEAGUES.map((l) => {
                const on = prefs.follows.includes(String(l.id));
                return <ChipBtn key={l.id} label={l.zh} active={on} onClick={() => setPrefs({ follows: on ? prefs.follows.filter((x) => x !== String(l.id)) : [...prefs.follows, String(l.id)] })} />;
              })}
            </div>
            <Label text="涨跌配色" />
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {(["红升绿降", "绿升红降"] as Scheme[]).map((n) => (
                <ChipBtn key={n} label={n} active={prefs.scheme === n} onClick={() => setPrefs({ scheme: n })} flex />
              ))}
            </div>
            <Label text="界面语言" />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {LANGS.map((l) => (
                <ChipBtn key={l} label={l} active={prefs.lang === l} onClick={() => setPrefs({ lang: l as Lang })} />
              ))}
            </div>
            <Label text="时区" />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {TZS.map(([tz, label]) => (
                <ChipBtn key={tz} label={label} active={prefs.tz === tz} onClick={() => setPrefs({ tz })} />
              ))}
            </div>
            <Label text="外观" />
            <div style={{ display: "flex", gap: 6 }}>
              {(["深色", "浅色"] as const).map((t) => (
                <ChipBtn key={t} label={t} active={prefs.theme === t} onClick={() => setPrefs({ theme: t })} flex />
              ))}
            </div>
          </Block>

          {/* 工单 */}
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>系统工单</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              {TK_TYPES.map((t) => (
                <ChipBtn key={t} label={t} active={tkType === t} onClick={() => setTkType(t)} />
              ))}
            </div>
            <textarea
              id="tk2"
              rows={3}
              placeholder="请描述你遇到的问题或建议…"
              style={{ width: "100%", boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 8, padding: 10, fontSize: 12, color: "var(--fg)", outline: "none", resize: "none", lineHeight: 1.6 }}
            />
            {tkMsg && <div style={{ fontSize: 11, color: tkMsg.ok ? "var(--up)" : "var(--red)", marginTop: 5, textAlign: tkMsg.ok ? "center" : "left" }}>{tkMsg.text}</div>}
            <div onClick={submitTicket} style={{ background: "var(--gold)", color: "var(--on-accent)", borderRadius: 8, textAlign: "center", padding: "9px 0", fontSize: 12, fontWeight: 800, cursor: "pointer", marginTop: 8 }}>提交工单</div>
            {tickets.slice(0, 5).map((t) => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line-soft)", marginTop: 6 }}>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)" }}>T{t.id}</span>
                <span style={{ flex: 1, fontSize: 11, fontWeight: 700 }}>{t.type}</span>
                <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 4, padding: "2px 6px", background: t.status === "处理中" ? "rgba(0,200,5,.14)" : "rgba(46,204,138,.14)", color: t.status === "处理中" ? "var(--gold)" : "var(--green)" }}>{t.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
