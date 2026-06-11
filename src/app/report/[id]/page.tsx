"use client";

/** AI 分析报告(二级页):头卡 + 七维对比 + 五分区正文;锁定时显示解锁卡 */
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { ProbBar } from "@/components/charts";
import { ShareSheet, type ShareData } from "@/components/share-sheet";
import { useUnlockFlow } from "@/components/unlock-flow";
import { Card, GoldBtn, LockIcon, SubpageHeader, ShareIcon } from "@/components/ui";
import { nowStr } from "@/lib/format";
import { leagueColor } from "@/lib/leagues";
import { useIsDesktop } from "@/components/use-viewport";
import { Terminal } from "@/components/desktop/terminal";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export default function ReportRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <Terminal initialMatchId={Number(id)} initialTab="report" /> : <MobileReportPage id={id} />;
}

function MobileReportPage({ id }: { id: string }) {
  const [v, setV] = useState<V | null>(null);
  const [share, setShare] = useState<ShareData | null>(null);
  const { prefs, me } = useApp();
  const router = useRouter();
  const flow = useUnlockFlow(() => void load());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/report/${id}?tz=${encodeURIComponent(prefs.tz)}`, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setV(j);
    } catch {
      /* keep */
    }
  }, [id, prefs.tz]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!v)
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-3)", fontSize: 12 }}>加载中…</div>
    );

  const compRows = Object.entries(v.comparison as Record<string, { home: number; away: number }>);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <SubpageHeader
        title="AI 分析报告"
        right={
          <div
            onClick={() =>
              setShare({
                title: v.match, sub: `${v.league} · ${v.time}`,
                v1: `主胜 ${v.pH}%`, v2: `平 ${v.pD}%`, v3: `客胜 ${v.pA}%`,
                url: `www.play.top/report/${v.id}`, inviteCode: me.inviteCode,
              })
            }
            style={{ cursor: "pointer", color: "var(--fg-2)" }}
          >
            <ShareIcon />
          </div>
        }
      />
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 12px 16px", minHeight: 0 }}>
        <Card style={{ borderRadius: 14, padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: leagueColor(v.leagueId) }} />
            <span style={{ fontSize: 11, color: "var(--fg-2)", fontWeight: 600 }}>{v.league}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", whiteSpace: "nowrap", flexShrink: 0 }}>{v.time}</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 10 }}>{v.match}</div>
          <ProbBar pH={v.pH} pD={v.pD} pA={v.pA} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "8px 10px" }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>结论</span>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: v.locked ? "var(--fg-3)" : "var(--gold)" }}>
              {v.locked ? "解锁本场后查看完整结论" : v.advice}
            </span>
          </div>
        </Card>

        <Card style={{ borderRadius: 14, padding: "13px 14px", marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--gold)" }} />
            <span style={{ fontSize: 13, fontWeight: 800 }}>七维对比</span>
          </div>
          <div style={{ background: "#0e1117", borderRadius: 8, padding: "8px 10px 4px" }}>
            {compRows.map(([label, c]) => (
              <div key={label} style={{ display: "grid", gridTemplateColumns: "30px 1fr 74px 1fr 30px", gap: 6, alignItems: "center", marginBottom: 5 }}>
                <span className="mono" style={{ fontSize: 10, color: "var(--home)" }}>{c.home}%</span>
                <div style={{ display: "flex", justifyContent: "flex-end", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "var(--home)", width: `${c.home}%` }} />
                </div>
                <span style={{ fontSize: 9, color: "var(--fg-3)", textAlign: "center" }}>{label}</span>
                <div style={{ height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "var(--gold)", width: `${c.away}%` }} />
                </div>
                <span className="mono" style={{ fontSize: 10, color: "var(--gold)", textAlign: "right" }}>{c.away}%</span>
              </div>
            ))}
          </div>
        </Card>

        {v.locked && (
          <div style={{ background: "linear-gradient(180deg,#1a1e29,#12141a)", border: "1px solid rgba(233,185,73,.35)", borderRadius: 14, padding: 16, marginTop: 10, textAlign: "center" }}>
            <LockIcon size={22} />
            <div style={{ fontSize: 14, fontWeight: 800, margin: "8px 0 5px" }}>完整报告已锁定</div>
            <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.7, marginBottom: 12 }}>
              包含盘口解读、状态盘路、进球模型、人员情报与结论
              <br />
              解锁本场后即可阅读全文
            </div>
            <GoldBtn
              label={v.loggedIn ? `${v.price} 积分 · 解锁本场查看报告` : "登录领 58 积分 · 免费解锁本场"}
              onClick={() => (v.loggedIn ? flow.open({ id: v.id, match: v.match, price: v.price }) : router.push("/login"))}
            />
          </div>
        )}

        {(v.sections ?? []).map((sec: V) => (
          <Card key={sec.h} style={{ borderRadius: 14, padding: "13px 14px", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--gold)" }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>{sec.h}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sec.ps.map((x: string, i: number) => (
                <div key={i} style={{ fontSize: 12, color: "var(--fg-mid)", lineHeight: 1.8 }}>{x}</div>
              ))}
            </div>
          </Card>
        ))}

        {!v.locked && (
          <div
            onClick={() => router.push(`/match/${v.id}`)}
            style={{ marginTop: 12, textAlign: "center", padding: "11px 0", borderRadius: 10, border: "1px solid rgba(233,185,73,.4)", color: "var(--gold)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            查看比赛详情与实时盘口 ›
          </div>
        )}
        <div style={{ textAlign: "center", fontSize: 10, color: "var(--fg-4)", padding: "12px 16px 0", lineHeight: 1.6 }}>
          报告由 AI 基于本场赛前数据自动生成 · 生成于 {nowStr()} · 仅供参考
        </div>
      </div>
      <ShareSheet open={!!share} onClose={() => setShare(null)} data={share} />
      {flow.ui}
    </div>
  );
}
