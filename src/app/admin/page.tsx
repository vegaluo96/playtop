"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { MARKET_LABEL, STATUS_LABEL, Stat, Tag } from "@/components/ui";

/**
 * 值班台：全自动产品的后台只回答三个问题——
 * ① 自动化还活着吗（任务心跳）② 哪里需要人（异常队列）③ 今天产出了什么（今日窗口）。
 * 业务数字与审计日志下沉到页尾。
 */

const JOBS: { name: string; label: string; cadence: string; expectMin: number }[] = [
  { name: "state_machine", label: "状态机（锁定/结算）", cadence: "每 10 分钟", expectMin: 10 },
  { name: "hot_window", label: "临场冲刺（30~10min 每5分 / 最后10min 每分钟）", cadence: "每分钟 tick", expectMin: 1 },
  { name: "live_revisions", label: "采集→建模→发布→改版", cadence: "每 30 分钟", expectMin: 30 },
  { name: "fetch_results", label: "赛果回填", cadence: "每 2 小时", expectMin: 120 },
  { name: "sync_fixtures", label: "赛程同步", cadence: "每 6 小时", expectMin: 360 },
];

interface MatchLite {
  id: number;
  league: string;
  round: string | null;
  homeName: string;
  awayName: string;
  kickoffAt: number;
  status: string;
}

interface Dashboard {
  statusCounts: { status: string; n: number }[];
  todayUnlocks: number;
  todayPoints: { granted: number; spent: number } | null;
  userCount: number;
  historyCount: number;
  record: { market: string; n: number; hits: number; misses: number; hitRate: number | null; roi: number | null }[];
  calibration: { n: number; model: { rps: number; logLoss: number } | null; market: { rps: number; logLoss: number } | null };
  recentAudit: { id: number; actorId: number; action: string; entity: string; entityId: number | null; createdAt: number }[];
  heartbeats: Record<string, { at: number; ok: boolean; note: string }>;
  attention: {
    pendingOutcomes: { matchId: number; homeGoals: number; awayGoals: number; source: string; recordedAt: number; homeName: string; awayName: string }[];
    stuck: MatchLite[];
    staleInPlay: MatchLite[];
    sourceIssues: { source: string; label: string; consecutiveFails: number; lastError: string | null; disabled: boolean }[];
  };
  todayMatches: MatchLite[];
  automation: { autoCollect: boolean; autoAnalyze: boolean; autoPublish: boolean; autoConfirmAiResults: boolean };
}

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

function untilKickoff(t: number): string {
  const m = Math.round((t - Date.now()) / 60_000);
  if (m <= 0) return "已开球";
  if (m < 60) return `${m} 分钟后`;
  return `${(m / 60).toFixed(1)} 小时后`;
}

export default function AdminDuty() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobMsg, setJobMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Dashboard>("/api/admin/dashboard").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function runJob(name: string) {
    setBusy(true);
    setJobMsg(`正在执行 ${name}…`);
    try {
      const r = await api(`/api/admin/jobs/run`, { method: "POST", body: JSON.stringify({ name }) });
      setJobMsg(`✓ ${name} 完成：${JSON.stringify(r).slice(0, 300)}`);
      void load();
    } catch (e) {
      setJobMsg(`✗ ${name} 失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-down">{error}</p>;
  if (!data) return <p className="text-muted">加载中…</p>;

  const att = data.attention;
  const attentionCount = att.pendingOutcomes.length + att.stuck.length + att.staleInPlay.length + att.sourceIssues.length;
  const autoOff = [
    !data.automation.autoCollect && "自动采集",
    !data.automation.autoAnalyze && "自动建模",
    !data.automation.autoPublish && "自动发布",
    !data.automation.autoConfirmAiResults && "赛果自动确认",
  ].filter(Boolean) as string[];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-lg tracking-wider">值班台</h1>
        <span className="text-[10px] text-faint">30s 自动刷新</span>
      </div>

      {/* ① 自动化心跳 */}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {JOBS.map((j) => {
          const hb = data.heartbeats[j.name];
          // 假死检测：进程整体挂掉时心跳停在最后一次"✓"——超计划周期 2 倍未跳即视为停摆
          const stalled = hb && Date.now() - hb.at > 2 * j.expectMin * 60_000;
          return (
            <div key={j.name} className={`card px-3 py-2.5 ${(hb && !hb.ok) || stalled ? "border-down/50" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-ink">{j.label}</span>
                <button
                  disabled={busy}
                  onClick={() => runJob(j.name)}
                  className="rounded border border-hairline px-2 py-0.5 text-[10px] text-muted hover:border-gold/50 hover:text-gold-bright disabled:opacity-50"
                >
                  立即执行
                </button>
              </div>
              <div className="mt-1 text-[10.5px] text-faint">
                计划 {j.cadence} ·{" "}
                {hb ? (
                  stalled ? (
                    <span className="text-down">⚠ 疑似停摆：最后心跳 {ago(hb.at)}（检查容器/调度器）</span>
                  ) : (
                    <span className={hb.ok ? "text-up" : "text-down"}>
                      {hb.ok ? "✓" : "✗"} {ago(hb.at)}
                    </span>
                  )
                ) : (
                  <span className="text-faint">尚无心跳（等待首次执行）</span>
                )}
              </div>
              {hb && !hb.ok && <div className="mt-1 break-all text-[10px] text-down/80">{hb.note}</div>}
            </div>
          );
        })}
      </div>
      {autoOff.length > 0 && (
        <p className="mt-2 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-[11px] text-gold-bright">
          注意：{autoOff.join("、")}已关闭，对应环节需人工执行（系统设置可重新开启）。
        </p>
      )}
      {jobMsg && <p className="mt-2 break-all text-[11px] text-muted">{jobMsg}</p>}

      {/* ② 需要人工 */}
      <h2 className="font-display mt-7 text-sm tracking-wider text-muted">
        需要人工 {attentionCount > 0 ? <span className="text-down">（{attentionCount} 项）</span> : ""}
      </h2>
      {attentionCount === 0 ? (
        <div className="card mt-2 border-up/30 px-4 py-3 text-[12px] text-up">✓ 当前没有需要人工处理的事项，流水线全自动运行中。</div>
      ) : (
        <div className="mt-2 space-y-2">
          {att.pendingOutcomes.map((o) => (
            <Link key={`po-${o.matchId}`} href={`/admin/matches/${o.matchId}`} className="card flex items-center justify-between px-3.5 py-2.5 hover:border-gold/40">
              <span className="text-[12px] text-ink">
                <Tag tone="gold">赛果待确认</Tag>
                <span className="ml-2">
                  {o.homeName} {o.homeGoals}:{o.awayGoals} {o.awayName}
                </span>
                <span className="ml-2 text-[10px] text-faint">来源 {o.source} · {ago(o.recordedAt)}</span>
              </span>
              <span className="text-[11px] text-gold-bright">去确认 →</span>
            </Link>
          ))}
          {att.stuck.map((m) => (
            <Link key={`st-${m.id}`} href={`/admin/matches/${m.id}`} className="card flex items-center justify-between px-3.5 py-2.5 hover:border-gold/40">
              <span className="text-[12px] text-ink">
                <Tag tone="down">临近开球未发布</Tag>
                <span className="ml-2">{m.homeName} vs {m.awayName}</span>
                <span className="ml-2 text-[10px] text-faint">
                  {untilKickoff(m.kickoffAt)}开球 · 当前 {STATUS_LABEL[m.status]?.text ?? m.status}
                </span>
              </span>
              <span className="text-[11px] text-gold-bright">去推进 →</span>
            </Link>
          ))}
          {att.staleInPlay.map((m) => (
            <Link key={`sp-${m.id}`} href={`/admin/matches/${m.id}`} className="card flex items-center justify-between px-3.5 py-2.5 hover:border-gold/40">
              <span className="text-[12px] text-ink">
                <Tag tone="down">完场超时无赛果</Tag>
                <span className="ml-2">{m.homeName} vs {m.awayName}</span>
                <span className="ml-2 text-[10px] text-faint">开球于 {fmtTs(m.kickoffAt)}</span>
              </span>
              <span className="text-[11px] text-gold-bright">去录赛果 →</span>
            </Link>
          ))}
          {att.sourceIssues.map((s) => (
            <Link key={`si-${s.source}`} href="/admin/settings" className="card flex items-center justify-between px-3.5 py-2.5 hover:border-gold/40">
              <span className="min-w-0 text-[12px] text-ink">
                <Tag tone={s.disabled ? "down" : "gold"}>{s.disabled ? "数据源已停用" : "数据源连败"}</Tag>
                <span className="ml-2">{s.label}</span>
                <span className="ml-2 text-[10px] text-faint">连败 {s.consecutiveFails} 次{s.lastError ? ` · ${s.lastError.slice(0, 60)}` : ""}</span>
              </span>
              <span className="shrink-0 text-[11px] text-gold-bright">去体检 →</span>
            </Link>
          ))}
        </div>
      )}

      {/* ③ 今日窗口 */}
      <h2 className="font-display mt-7 text-sm tracking-wider text-muted">今日窗口（前 6h ~ 后 24h 开球，{data.todayMatches.length} 场）</h2>
      {data.todayMatches.length === 0 ? (
        <p className="card mt-2 px-4 py-3 text-[12px] text-faint">窗口内无比赛。</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="tabular w-full min-w-[560px] text-[12px]">
            <tbody>
              {data.todayMatches.map((m) => {
                const s = STATUS_LABEL[m.status] ?? { text: m.status, tone: "default" as const };
                return (
                  <tr key={m.id} className="border-t border-hairline hover:bg-overlay/40">
                    <td className="py-2 text-faint">{fmtTs(m.kickoffAt)}</td>
                    <td className="py-2 text-muted">{untilKickoff(m.kickoffAt)}</td>
                    <td className="py-2">
                      <Link href={`/admin/matches/${m.id}`} className="text-ink underline-offset-4 hover:text-gold-bright hover:underline">
                        {m.homeName} vs {m.awayName}
                      </Link>
                    </td>
                    <td className="py-2 text-faint">
                      {m.league}
                      {m.round ? ` · ${m.round}` : ""}
                    </td>
                    <td className="py-2 text-right">
                      <Tag tone={s.tone}>{s.text}</Tag>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 页尾：业务与战绩 / 状态分布 / 审计 */}
      <h2 className="font-display mt-8 text-sm tracking-wider text-muted">业务与战绩</h2>
      <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="注册用户" value={data.userCount} />
        <Stat label="今日解锁" value={data.todayUnlocks} accent />
        <Stat label="今日发放积分" value={data.todayPoints?.granted ?? 0} />
        <Stat label="今日消耗积分" value={data.todayPoints?.spent ?? 0} />
        <Stat label="历史样本库" value={data.historyCount.toLocaleString()} sub="场赛果" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {data.record.map((r) => (
          <Stat
            key={r.market}
            label={MARKET_LABEL[r.market] ?? r.market}
            value={r.hitRate !== null ? `${(r.hitRate * 100).toFixed(1)}%` : "—"}
            sub={`${r.hits}胜${r.misses}负 · ROI ${r.roi !== null ? (r.roi * 100).toFixed(1) + "%" : "—"}`}
          />
        ))}
        <Stat
          label="RPS 模型/市场"
          value={data.calibration.model ? data.calibration.model.rps.toFixed(4) : "—"}
          sub={data.calibration.market ? `市场 ${data.calibration.market.rps.toFixed(4)}（n=${data.calibration.n}）` : ""}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {data.statusCounts.map((s) => (
          <Link
            key={s.status}
            href={`/admin/matches?f=${s.status}`}
            className="rounded border border-hairline bg-surface px-2.5 py-1 text-[11px] text-muted hover:border-gold/50 hover:text-gold-bright"
          >
            {STATUS_LABEL[s.status]?.text ?? s.status} <b className="text-ink">{s.n}</b>
          </Link>
        ))}
      </div>

      <details className="mt-6">
        <summary className="font-display cursor-pointer text-sm tracking-wider text-muted">最近审计日志（{data.recentAudit.length} 条）</summary>
        <table className="tabular mt-2 w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10px] tracking-wider text-faint">
              <th className="pb-1 font-normal">时间</th>
              <th className="pb-1 font-normal">操作人</th>
              <th className="pb-1 font-normal">动作</th>
              <th className="pb-1 font-normal">对象</th>
            </tr>
          </thead>
          <tbody>
            {data.recentAudit.map((a) => (
              <tr key={a.id} className="border-t border-hairline text-muted">
                <td className="py-1.5">{fmtTs(a.createdAt)}</td>
                <td className="py-1.5">{a.actorId === 0 ? "系统" : `#${a.actorId}`}</td>
                <td className="py-1.5">{a.action}</td>
                <td className="py-1.5">
                  {a.entity}
                  {a.entityId ? ` #${a.entityId}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
