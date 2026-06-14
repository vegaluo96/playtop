"use client";

/** AI 概率报告(二级页):头卡 + 七维对比 + 五分区正文;锁定时显示解锁卡 */
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApp } from "@/components/app-context";
import { ProbBar } from "@/components/charts";
import { ShareSheet, type ShareData } from "@/components/share-sheet";
import { useUnlockFlow } from "@/components/unlock-flow";
import { Card, GoldBtn, LockIcon, SubpageHeader, ShareIcon } from "@/components/ui";
import { SourceBadge, CoverageStrip } from "@/components/source-trust";
import { nowStr } from "@/lib/format";
import { leagueColor } from "@/lib/leagues";
import { useIsDesktop } from "@/components/use-viewport";
import { LazyTerminal } from "@/components/desktop/lazy-terminal";
import { SITE_HOST } from "@/lib/site";
import type { ReportResponse } from "@/app/api/report/[id]/route";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export default function ReportRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const isDesktop = useIsDesktop();
  if (isDesktop == null) return null;
  return isDesktop ? <LazyTerminal initialMatchId={Number(id)} initialTab="report" /> : <MobileReportPage id={id} />;
}

function MobileReportPage({ id }: { id: string }) {
  const [v, setV] = useState<ReportResponse | null>(null);
  const [share, setShare] = useState<ShareData | null>(null);
  const { prefs, me } = useApp();
  const router = useRouter();
  const flow = useUnlockFlow(() => void load());

  const load = useCallback(async (ver?: number) => {
    try {
      const r = await fetch(`/api/report/${id}?tz=${encodeURIComponent(prefs.tz)}${ver ? `&v=${ver}` : ""}`, { cache: "no-store" });
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

  const compRows = Object.entries((v.comparison ?? {}) as Record<string, { home: number; away: number }>);
  const summaryText = v.locked ? "解锁后查看完整摘要" : v.advice ?? "概率快照积累中,方向待真实信号补齐";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <SubpageHeader
        title="AI 概率报告"
        right={
          <div
            onClick={() =>
              setShare({
                title: v.match, sub: `${v.league} · ${v.time}`,
                v1: v.probReady ? `主胜 ${v.pH}%` : "主胜 —",
                v2: v.probReady ? `平 ${v.pD}%` : "平 —",
                v3: v.probReady ? `客胜 ${v.pA}%` : "客胜 —",
                url: `${SITE_HOST}/report/${v.id}`, inviteCode: me.inviteCode,
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
            <span style={{ fontSize: 12, color: "var(--fg-2)", fontWeight: 650 }}>{v.league}</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)", whiteSpace: "nowrap", flexShrink: 0 }}>{v.time}</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 10 }}>{v.match}</div>
          <ProbBar pH={v.pH} pD={v.pD} pA={v.pA} empty={!v.probReady} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", borderRadius: 8, padding: "8px 10px" }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--fg-2)", background: "var(--line)", borderRadius: 4, padding: "2px 7px", flexShrink: 0 }}>摘要</span>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: v.locked || !v.summaryReady ? "var(--fg-3)" : "var(--fg-1)" }}>
              {summaryText}
            </span>
          </div>
          {!v.locked && v.directions && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              {([
                ["亚盘方向", v.directions.ah, v.model?.ahScore],
                ["大小方向", v.directions.ou, v.model?.ouScore],
              ] as const).map(([label, sig, score]) => (
                <div key={label as string} style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 9px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>{label as string}</span>
                    <SourceBadge signal={sig as V} style={{ marginLeft: "auto" }} />
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 850 }}>{((sig as V)?.text as string) || "暂无明确方向"}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 4 }}>score {score ?? "—"}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card style={{ borderRadius: 14, padding: "13px 14px", marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--fg-1)" }} />
            <span style={{ fontSize: 13, fontWeight: 800 }}>七维对比</span>
          </div>
          <div style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 10px 4px" }}>
            {compRows.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--fg-3)", padding: "10px 0" }}>七维对比积累中</div>
            )}
            {compRows.map(([label, c]) => (
              <div key={label} style={{ display: "grid", gridTemplateColumns: "30px 1fr 74px 1fr 30px", gap: 6, alignItems: "center", marginBottom: 5 }}>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--home)" }}>{c.home}%</span>
                <div style={{ display: "flex", justifyContent: "flex-end", height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "var(--home)", width: `${c.home}%` }} />
                </div>
                <span style={{ fontSize: 11.5, color: "var(--fg-3)", textAlign: "center" }}>{label}</span>
                <div style={{ height: 4, background: "var(--inset)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "var(--team-away)", width: `${c.away}%` }} />
                </div>
                <span className="mono" style={{ fontSize: 11.5, color: "var(--team-away)", textAlign: "right" }}>{c.away}%</span>
              </div>
            ))}
          </div>
        </Card>

        {!v.locked && v.model && (
          <Card style={{ borderRadius: 14, padding: "13px 14px", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--fg-1)" }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>量化模型</span>
              <span className="mono" style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--fg-3)" }}>模型输入覆盖 {v.model.coverage}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 9px" }}>
                <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>AH 评分</div>
                <div className="mono" style={{ fontSize: 17, fontWeight: 850 }}>{v.model.ahScore ?? "—"}</div>
              </div>
              <div style={{ background: "var(--inset)", borderRadius: 8, padding: "8px 9px" }}>
                <div style={{ fontSize: 11.5, color: "var(--fg-3)" }}>OU 评分</div>
                <div className="mono" style={{ fontSize: 17, fontWeight: 850 }}>{v.model.ouScore ?? "—"}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {(v.model.inputs ?? []).filter((x: V) => x.status === "used").map((x: V) => (
                <div key={x.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--fg-2)" }}>
                  <span style={{ flex: 1 }}>{x.label}</span>
                  <span className="mono">{x.weight}%</span>
                </div>
              ))}
              {(() => {
                // 未参与维度折叠为一行,主列表只列实际计入项(去重)
                const missing = [...new Set((v.model.inputs ?? []).filter((x: V) => x.status !== "used").map((x: V) => x.label as string))];
                return missing.length > 0 ? (
                  <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2, lineHeight: 1.5 }}>未计入(暂无真实来源):{missing.join("、")}</div>
                ) : null;
              })()}
            </div>
          </Card>
        )}

        {!v.locked && v.sourceCoverage && <CoverageStrip coverage={v.sourceCoverage} style={{ marginTop: 10 }} />}

        {v.locked && (
          <div style={{ background: "var(--card)", border: "1px solid var(--selected-border)", borderRadius: 14, padding: 16, marginTop: 10, textAlign: "center" }}>
            <LockIcon size={22} />
            <div style={{ fontSize: 14, fontWeight: 800, margin: "8px 0 5px" }}>完整概率报告已锁定</div>
            <div style={{ fontSize: 12, color: "var(--fg-2)", lineHeight: 1.7, marginBottom: 12 }}>
              指数解读、盘路状态、进球模型与人员情报
            </div>
            <GoldBtn
              label={v.loggedIn ? `${v.price} 额度 · 解锁本场报告` : "登录查看报告额度说明"}
              onClick={() => (v.loggedIn ? flow.open({ id: v.id, match: v.match, price: v.price }) : router.push("/login"))}
            />
          </div>
        )}

        {!v.locked && (v.versions ?? []).length > 0 && (
          <Card style={{ borderRadius: 12, padding: "9px 12px", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11.5, color: "var(--fg-3)", marginRight: 2 }}>
                {v.lockedFinal ? `已开赛锁定 · 共 ${v.versions.length} 版` : `随指数变化更新 · 共 ${v.versions.length} 版`}
              </span>
              {v.versions.map((vv: V) => (
                <span
                  key={vv.ver}
                  onClick={() => void load(vv.ver)}
                  className="mono"
                  style={{
                    fontSize: 11.5, fontWeight: 800, cursor: "pointer", borderRadius: 6, padding: "2px 8px",
                    background: v.ver === vv.ver ? "var(--selected-bg-strong)" : "var(--inset)",
                    color: v.ver === vv.ver ? "var(--fg-1)" : "var(--fg-2)",
                  }}
                >
                  v{vv.ver}
                </span>
              ))}
            </div>
            {(() => {
              const cur = (v.versions ?? []).find((x) => x.ver === v.ver);
              return cur && cur.changed && cur.changed.length > 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--fg-1)", marginTop: 6 }}>本版更新:{cur.changed.join(" · ")}</div>
              ) : null;
            })()}
          </Card>
        )}

        {(v.sections ?? []).map((sec: V) => (
          <Card key={sec.h} style={{ borderRadius: 14, padding: "13px 14px", marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ width: 3, height: 13, borderRadius: 2, background: "var(--fg-1)" }} />
              <span style={{ fontSize: 13, fontWeight: 800 }}>{sec.h}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sec.ps.map((x: string, i: number) => (
                <div key={i} style={{ fontSize: 13, color: "var(--fg-mid)", lineHeight: 1.85 }}>{x}</div>
              ))}
            </div>
          </Card>
        ))}

        {!v.locked && (
          <div
            onClick={() => router.push(`/match/${v.id}`)}
            style={{ marginTop: 12, textAlign: "center", padding: "11px 0", borderRadius: 10, border: "1px solid var(--selected-border)", color: "var(--fg-1)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            查看比赛详情与实时指数 ›
          </div>
        )}
        <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--fg-3)", padding: "12px 16px 0", lineHeight: 1.6 }}>
          报告按数据快照生成 · {nowStr()} · 概率视角仅供研究
        </div>
      </div>
      <ShareSheet open={!!share} onClose={() => setShare(null)} data={share} />
      {flow.ui}
    </div>
  );
}
