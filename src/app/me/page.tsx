"use client";

/** 我:钱包/邀请/记录入口/关注/配色/语言/外观/时区/工单/退出 + 新人礼包弹窗 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp, type Scheme } from "@/components/app-context";
import { PageHeader } from "@/components/page-header";
import { RiskFooter } from "@/components/consent-bar";
import { useUnlockFlow } from "@/components/unlock-flow";
import { GoldBtn, Sheet, SheetTitle } from "@/components/ui";
import { LANGS, type Lang } from "@/lib/i18n";
import { LEAGUES } from "@/lib/leagues";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";
import { APP_VERSION } from "@/lib/version";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

const TZS: [string, string][] = [
  ["UTC+8", "北京 UTC+8"], ["UTC+9", "首尔 · 东京 UTC+9"], ["UTC+7", "曼谷 · 雅加达 UTC+7"], ["UTC+1", "伦敦 UTC+1"],
  ["UTC+2", "中欧 UTC+2"], ["UTC-4", "纽约 UTC-4"], ["UTC-7", "洛杉矶 UTC-7"], ["UTC+10", "悉尼 UTC+10"],
];

export default function MeRoute() {
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <Terminal initialDrawer /> : <MobileMePage />;
}

function MobileMePage() {
  const { prefs, setPrefs, me, refreshMe } = useApp();
  const router = useRouter();
  const flow = useUnlockFlow();
  const [sheet, setSheet] = useState<"invite" | "invlog" | "redeem" | "follow" | "lang" | "tz" | null>(null);
  const [sec, setSec] = useState<"scheme" | "theme" | null>(null);
  const [giftOpen, setGiftOpen] = useState(false);
  const [invite, setInvite] = useState<V | null>(null);
  const [ledgerCount, setLedgerCount] = useState<number | null>(null);
  const [rdMsg, setRdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [ticketNew, setTicketNew] = useState(false);

  useEffect(() => {
    if (me.loggedIn && me.giftPending) setGiftOpen(true);
  }, [me.loggedIn, me.giftPending]);

  useEffect(() => {
    if (!me.loggedIn) return;
    void fetch("/api/wallet").then((r) => r.json()).then((j) => j.ok && setLedgerCount(j.ledger.length));
  }, [me.loggedIn, me.pts]);

  // 工单有新回复 → 「系统工单」行红点提示(进入工单页即标记已读)
  useEffect(() => {
    if (!me.loggedIn) return;
    void fetch("/api/tickets")
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) return;
        const latest = Math.max(0, ...(j.tickets as { replied_at?: number | null }[]).map((t) => t.replied_at ?? 0));
        const seen = Number(localStorage.getItem("playtop.tickets.seen") ?? 0);
        setTicketNew(latest > seen);
      })
      .catch(() => {});
  }, [me.loggedIn]);

  const openInvite = async () => {
    if (!me.loggedIn) {
      router.push("/login");
      return;
    }
    setCopied(false);
    setSheet("invite");
    const j = await fetch("/api/invite").then((r) => r.json());
    if (j.ok) setInvite(j);
  };

  const claimGift = async () => {
    const j = await fetch("/api/wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "gift" }),
    }).then((r) => r.json());
    if (j.ok || j.error === "礼包已领取") {
      setGiftOpen(false);
      await refreshMe();
    }
  };

  const redeem = async () => {
    const el = document.getElementById("rd-code") as HTMLInputElement | null;
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
      setRdMsg({ ok: true, text: `兑换成功,${j.note} 积分已到账` });
      await refreshMe();
    } else setRdMsg({ ok: false, text: j.error });
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await refreshMe();
    router.push("/login");
  };

  const followsLabel =
    prefs.follows.length > 0
      ? prefs.follows.map((id) => LEAGUES.find((l) => String(l.id) === id)?.zh ?? id).join(" · ")
      : "未关注";

  const MenuRow = ({ label, sum, ch, onClick, border = true, sumColor }: { label: string; sum: string; ch?: string; onClick: () => void; border?: boolean; sumColor?: string }) => (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: 14, cursor: "pointer", borderTop: border ? "1px solid #1d212a" : undefined }}>
      <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{label}</span>
      <span style={{ fontSize: 11, color: sumColor ?? "var(--fg-2)", fontWeight: sumColor ? 700 : undefined, maxWidth: 170, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sum}</span>
      <span style={{ fontSize: 12, color: "var(--fg-3)", width: 12, textAlign: "center" }}>{ch ?? "›"}</span>
    </div>
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <PageHeader title="我" />
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 16px", minHeight: 0 }}>
        {me.loggedIn ? (
          <div style={{ background: "linear-gradient(135deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.3)", borderRadius: 14, padding: "16px 16px 15px", marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 10, color: "var(--fg-2)" }}>登录账户</span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-mid)" }}>{me.email}</span>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: 10, color: "var(--fg-2)", marginBottom: 3 }}>积分余额</span>
                <span className="mono" style={{ fontSize: 30, lineHeight: 1, fontWeight: 800, color: "var(--gold)" }}>{me.pts}</span>
              </span>
              <div onClick={() => { setRdMsg(null); setSheet("redeem"); }} style={{ border: "1px solid rgba(233,185,73,.5)", color: "var(--gold)", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>兑换</div>
              <div onClick={flow.openRecharge} style={{ background: "linear-gradient(90deg,var(--gold),var(--gold-2))", color: "#0a0b0f", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>充值</div>
            </div>
          </div>
        ) : (
          <div style={{ background: "linear-gradient(135deg,#2a2410,#12141a)", border: "1px solid rgba(233,185,73,.4)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>
              注册免费看全站 · 再领 <span style={{ color: "var(--gold)" }}>58 积分</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-2)", marginBottom: 10, lineHeight: 1.6 }}>注册后全部盘口与异动免费查看;58 积分可解锁 1 场官方预测</div>
            <GoldBtn label="邮箱登录 / 注册" onClick={() => router.push("/login")} style={{ padding: "10px 0", fontSize: 13 }} />
          </div>
        )}

        <div onClick={openInvite} style={{ display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(135deg,#2a2410,#12141a)", border: "1px solid rgba(233,185,73,.4)", borderRadius: 14, padding: "12px 14px", marginBottom: 12, cursor: "pointer" }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#0a0b0f", fontWeight: 800 }}>+1</span>
          <span style={{ flex: 1 }}>
            <span style={{ display: "block", fontSize: 13, fontWeight: 800 }}>邀请好友 · 每人 +1 积分</span>
            <span style={{ fontSize: 10, color: "var(--fg-2)" }}>每日上限 10 · 每周 30 · 每月 100</span>
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--gold)", flexShrink: 0 }}>去邀请 ›</span>
        </div>

        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
          {me.loggedIn && (
            <MenuRow label="充值 / 消费记录" sum={ledgerCount != null ? `${ledgerCount} 笔` : ""} onClick={() => router.push("/me/ledger")} border={false} />
          )}
          <MenuRow label="关注联赛" sum={followsLabel} onClick={() => setSheet("follow")} border={me.loggedIn} />
          <MenuRow label="涨跌配色" sum={prefs.scheme} ch={sec === "scheme" ? "▾" : "›"} onClick={() => setSec(sec === "scheme" ? null : "scheme")} />
          {sec === "scheme" && (
            <div style={{ padding: "2px 14px 12px" }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {(["红升绿降", "绿升红降"] as Scheme[]).map((n) => (
                  <div
                    key={n}
                    onClick={() => setPrefs({ scheme: n })}
                    style={{ flex: 1, textAlign: "center", padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", background: prefs.scheme === n ? "rgba(233,185,73,.14)" : "var(--inset)", color: prefs.scheme === n ? "var(--gold)" : "var(--fg-2)", border: `1px solid ${prefs.scheme === n ? "rgba(233,185,73,.45)" : "var(--line)"}` }}
                  >
                    {n}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 18, justifyContent: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--up)" }}>▲ 升盘 / 升水</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--down)" }}>▼ 降盘 / 降水</span>
              </div>
            </div>
          )}
          <MenuRow label="界面语言" sum={prefs.lang} onClick={() => setSheet("lang")} />
          <MenuRow label="外观" sum={prefs.theme} ch={sec === "theme" ? "▾" : "›"} onClick={() => setSec(sec === "theme" ? null : "theme")} />
          {sec === "theme" && (
            <div style={{ padding: "2px 14px 12px" }}>
              <div style={{ display: "flex", gap: 8 }}>
                {(["深色", "浅色"] as const).map((t) => (
                  <div
                    key={t}
                    onClick={() => setPrefs({ theme: t })}
                    style={{ flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", background: prefs.theme === t ? "rgba(233,185,73,.14)" : "var(--inset)", color: prefs.theme === t ? "var(--gold)" : "var(--fg-2)", border: `1px solid ${prefs.theme === t ? "rgba(233,185,73,.45)" : "var(--line)"}` }}
                  >
                    {t}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, color: "var(--fg-3)", marginTop: 10 }}>深色为推荐模式,浅色适合白天户外使用</div>
            </div>
          )}
          <MenuRow label="时区" sum={TZS.find((z) => z[0] === prefs.tz)?.[1] ?? prefs.tz} onClick={() => setSheet("tz")} />
          <MenuRow label="常见问题" sum="积分 · 数据口径 · 刷新规则" onClick={() => router.push("/faq")} />
          <MenuRow label="系统工单" sum={ticketNew ? "● 有新回复" : "提交问题"} sumColor={ticketNew ? "var(--red)" : undefined} onClick={() => router.push("/me/tickets")} />
        </div>

        {me.loggedIn && (
          <div onClick={logout} style={{ marginTop: 14, textAlign: "center", padding: "11px 0", borderRadius: 10, border: "1px solid rgba(240,67,79,.35)", color: "var(--red)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            退出登录
          </div>
        )}
        <div className="mono" style={{ textAlign: "center", fontSize: 9, color: "var(--fg-4)", padding: "14px 0 0" }}>
          足球终端 v{APP_VERSION} · <span onClick={() => router.push("/about")} style={{ cursor: "pointer", color: "var(--fg-3)" }}>关于与免责声明 ›</span>
        </div>
        <RiskFooter />
      </div>

      {/* 新人礼包 */}
      {giftOpen && (
        <div style={{ position: "absolute", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(4,5,9,.78)", padding: "0 40px" }}>
          <div style={{ background: "linear-gradient(180deg,#20242e,#14161d)", border: "1px solid rgba(233,185,73,.5)", borderRadius: 18, padding: "24px 22px", textAlign: "center", width: "100%" }}>
            <div style={{ width: 52, height: 52, borderRadius: "50%", background: "linear-gradient(135deg,var(--gold),var(--gold-2))", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 22, fontWeight: 800, color: "#0a0b0f" }}>礼</div>
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 6 }}>新人礼包</div>
            <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7, marginBottom: 16 }}>
              <span className="mono" style={{ color: "var(--gold)", fontWeight: 800, fontSize: 18 }}>58</span> 积分已备好
              <br />
              可解锁今日任意 1 场官方预测
            </div>
            <GoldBtn label="立即领取" onClick={claimGift} />
          </div>
        </div>
      )}

      {/* 邀请 */}
      <Sheet open={sheet === "invite"} onClose={() => setSheet(null)}>
        <SheetTitle title="邀请好友" hint="每成功邀请 1 人 +1 积分" />
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: "11px 12px", marginBottom: 6 }}>
          <span className="mono" style={{ flex: 1, fontSize: 12, fontWeight: 700, color: "var(--gold)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {invite?.url ?? "…"}
          </span>
          <div
            onClick={() => {
              try {
                void navigator.clipboard.writeText(`https://${invite?.url ?? ""}`);
              } catch { /* ignore */ }
              setCopied(true);
            }}
            style={{ flexShrink: 0, border: "1px solid rgba(233,185,73,.5)", color: "var(--gold)", borderRadius: 8, padding: "6px 14px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}
          >
            复制
          </div>
        </div>
        {copied && <div style={{ fontSize: 10, color: "var(--up)", marginBottom: 6 }}>已复制,发给好友吧</div>}
        <div style={{ background: "var(--inset)", borderRadius: 10, padding: "12px 14px", margin: "12px 0" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-2)", marginBottom: 10 }}>本期进度</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[["今日", invite?.day ?? 0, 10], ["本周", invite?.week ?? 0, 30], ["本月", invite?.month ?? 0, 100]].map(([label, n, cap]) => (
              <div key={label as string} style={{ display: "grid", gridTemplateColumns: "40px 1fr 58px", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{label as string}</span>
                <div style={{ height: 5, background: "#0e1117", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "linear-gradient(90deg,#8a6a1f,var(--gold))", borderRadius: 3, width: `${Math.min(100, ((n as number) / (cap as number)) * 100)}%` }} />
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right" }}>{n as number} / {cap as number}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "var(--fg-2)" }}>
            累计成功邀请 <span className="mono" style={{ color: "var(--fg)", fontWeight: 700 }}>{invite?.total ?? 0}</span> 人
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-2)" }}>
            累计 <span className="mono" style={{ color: "var(--gold)", fontWeight: 700 }}>+{invite?.totalPts ?? 0}</span> 积分
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--fg-3)", lineHeight: 1.9, borderTop: "1px solid #1d212a", paddingTop: 10 }}>
          好友通过你的链接注册即计 1 次<br />超出每日 10 / 每周 30 / 每月 100 上限的部分不计入
        </div>
        <div onClick={() => setSheet("invlog")} style={{ textAlign: "center", padding: "9px 0 0", fontSize: 11, fontWeight: 700, color: "var(--gold)", cursor: "pointer", borderTop: "1px solid #1d212a", marginTop: 10 }}>
          查看邀请记录 ›
        </div>
      </Sheet>

      {/* 邀请记录 */}
      <Sheet open={sheet === "invlog"} onClose={() => setSheet(null)} z={66}>
        <SheetTitle title="邀请记录" hint={`累计 ${invite?.total ?? 0} 人 · +${invite?.totalPts ?? 0} 积分`} />
        <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
          {(invite?.log ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--fg-3)", padding: "16px 0", textAlign: "center" }}>暂无邀请记录</div>}
          {(invite?.log ?? []).map((l: V, i: number) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 2px", borderBottom: "1px solid var(--line-soft)" }}>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{l.u}</span>
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{l.t}</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 800, color: l.credited > 0 ? "var(--up)" : "var(--fg-3)" }}>
                {l.credited > 0 ? "+1" : "未计入"}
              </span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 9, color: "var(--fg-3)", marginTop: 8 }}>超出每日 10 / 每周 30 / 每月 100 上限的部分不计入</div>
      </Sheet>

      {/* 兑换码 */}
      <Sheet open={sheet === "redeem"} onClose={() => setSheet(null)}>
        <SheetTitle title="兑换积分" hint="兑换码可通过活动与客服获得" />
        <input
          id="rd-code"
          placeholder="输入兑换码,如 WC2026"
          className="mono"
          style={{ width: "100%", boxSizing: "border-box", background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: "13px 14px", fontSize: 14, color: "var(--fg)", outline: "none", margin: "8px 0 6px", letterSpacing: 1 }}
        />
        {rdMsg && <div style={{ fontSize: 10, color: rdMsg.ok ? "var(--up)" : "var(--red)", marginBottom: 4 }}>{rdMsg.text}</div>}
        <GoldBtn label="立即兑换" onClick={redeem} style={{ marginTop: 6 }} />
      </Sheet>

      {/* 关注联赛 */}
      <Sheet open={sheet === "follow"} onClose={() => setSheet(null)}>
        <SheetTitle title="关注联赛" hint="可多选 · 关注的联赛优先展示" />
        <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
          {LEAGUES.map((l) => {
            const on = prefs.follows.includes(String(l.id));
            return (
              <div
                key={l.id}
                onClick={() => setPrefs({ follows: on ? prefs.follows.filter((x) => x !== String(l.id)) : [...prefs.follows, String(l.id)] })}
                style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 4px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: l.color }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: on ? "var(--gold)" : "var(--fg)" }}>{l.zh}</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)" }}>{on ? "✓" : ""}</span>
              </div>
            );
          })}
        </div>
      </Sheet>

      {/* 语言 */}
      <Sheet open={sheet === "lang"} onClose={() => setSheet(null)}>
        <SheetTitle title="界面语言" hint="更多语言持续添加中" />
        <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
          {LANGS.map((l) => (
            <div key={l} onClick={() => { setPrefs({ lang: l as Lang }); setSheet(null); }} style={{ display: "flex", alignItems: "center", padding: "13px 4px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: prefs.lang === l ? "var(--gold)" : "var(--fg)" }}>{l}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)" }}>{prefs.lang === l ? "✓" : ""}</span>
            </div>
          ))}
        </div>
      </Sheet>

      {/* 时区 */}
      <Sheet open={sheet === "tz"} onClose={() => setSheet(null)}>
        <SheetTitle title="时区" hint="影响全站赛事时间显示" />
        <div style={{ maxHeight: "46vh", overflowY: "auto" }}>
          {TZS.map(([tz, label]) => (
            <div key={tz} onClick={() => { setPrefs({ tz }); setSheet(null); }} style={{ display: "flex", alignItems: "center", padding: "13px 4px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: prefs.tz === tz ? "var(--gold)" : "var(--fg)" }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)" }}>{prefs.tz === tz ? "✓" : ""}</span>
            </div>
          ))}
        </div>
      </Sheet>

      {flow.ui}
    </div>
  );
}
