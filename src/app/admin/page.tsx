"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { MARKET_LABEL, STATUS_LABEL, Stat } from "@/components/ui";

/** 这些状态意味着有活等管理员干——置顶提醒 */
const TODO_HINT: Record<string, string> = {
  ready: "场数据就绪，待运行引擎建模",
  analyzed: "场已建模，草稿待审阅发布",
  finished: "场已完场，待录入/确认赛果",
};

const JOBS: { name: string; label: string; desc: string }[] = [
  { name: "state_machine", label: "推进状态机", desc: "检查全部比赛并自动流转状态" },
  { name: "live_revisions", label: "触发实时改版", desc: "已发布场次重采集→重算→发新版" },
  { name: "fetch_results", label: "抓取赛果", desc: "AI 检索完场比分（需人工确认）" },
  { name: "sync_fixtures", label: "同步赛程", desc: "联赛 CSV + 世界杯自动建赛" },
];

interface Dashboard {
  statusCounts: { status: string; n: number }[];
  todayUnlocks: number;
  todayPoints: { granted: number; spent: number } | null;
  userCount: number;
  historyCount: number;
  record: { market: string; n: number; hits: number; misses: number; hitRate: number | null; roi: number | null }[];
  calibration: { n: number; model: { rps: number; logLoss: number } | null; market: { rps: number; logLoss: number } | null };
  recentAudit: { id: number; actorId: number; action: string; entity: string; entityId: number | null; createdAt: number }[];
}

export default function AdminDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobMsg, setJobMsg] = useState("");

  const load = () => api<Dashboard>("/api/admin/dashboard").then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function runJob(name: string) {
    setJobMsg(`正在执行 ${name}…`);
    try {
      const r = await api(`/api/admin/jobs/run`, { method: "POST", body: JSON.stringify({ name }) });
      setJobMsg(`${name} 完成：${JSON.stringify(r)}`);
      void load();
    } catch (e) {
      setJobMsg(`${name} 失败：${e instanceof Error ? e.message : e}`);
    }
  }

  if (error) return <p className="text-down">{error}</p>;
  if (!data) return <p className="text-muted">加载中…</p>;

  const todos = data.statusCounts.filter((s) => TODO_HINT[s.status] && s.n > 0);

  return (
    <div>
      <h1 className="font-display text-lg tracking-widest">运营看板</h1>

      {todos.length > 0 && (
        <div className="card mt-4 border-gold/40 px-4 py-3">
          <div className="font-display text-[12px] tracking-widest text-gold-bright">待处理</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {todos.map((s) => (
              <Link
                key={s.status}
                href={`/admin/matches?f=${s.status}`}
                className="rounded border border-gold/40 bg-gold/10 px-3 py-1.5 text-[12px] text-gold-bright hover:bg-gold/20"
              >
                <b className="tabular">{s.n}</b> {TODO_HINT[s.status]} →
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="注册用户" value={data.userCount} />
        <Stat label="今日解锁" value={data.todayUnlocks} accent />
        <Stat label="今日发放积分" value={data.todayPoints?.granted ?? 0} />
        <Stat label="今日消耗积分" value={data.todayPoints?.spent ?? 0} />
        <Stat label="历史样本库" value={data.historyCount.toLocaleString()} sub="场赛果" />
      </div>

      <h2 className="font-display mt-8 text-sm tracking-widest text-muted">比赛状态分布（点击查看对应比赛）</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {data.statusCounts.map((s) => (
          <Link
            key={s.status}
            href={`/admin/matches?f=${s.status}`}
            className="rounded border border-hairline bg-surface px-3 py-1.5 text-[12px] text-muted hover:border-gold/50 hover:text-gold-bright"
          >
            {STATUS_LABEL[s.status]?.text ?? s.status} <b className="text-ink">{s.n}</b>
          </Link>
        ))}
      </div>

      <h2 className="font-display mt-8 text-sm tracking-widest text-muted">战绩与校准</h2>
      <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
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

      <h2 className="font-display mt-8 text-sm tracking-widest text-muted">手动触发任务（平时由调度器自动执行，这里仅用于立即生效）</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {JOBS.map((j) => (
          <button
            key={j.name}
            onClick={() => runJob(j.name)}
            title={j.name}
            className="rounded border border-hairline px-3 py-1.5 text-left text-[12px] text-muted hover:border-gold/50 hover:text-gold-bright"
          >
            {j.label}
            <span className="ml-2 text-[10px] text-faint">{j.desc}</span>
          </button>
        ))}
      </div>
      {jobMsg && <p className="mt-2 break-all text-[11px] text-muted">{jobMsg}</p>}

      <h2 className="font-display mt-8 text-sm tracking-widest text-muted">最近审计日志</h2>
      <table className="tabular mt-2 w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] tracking-widest text-faint">
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
              <td className="py-1.5">#{a.actorId}</td>
              <td className="py-1.5">{a.action}</td>
              <td className="py-1.5">
                {a.entity}
                {a.entityId ? ` #${a.entityId}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
