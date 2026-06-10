"use client";

import { useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { MARKET_LABEL, Stat } from "@/components/ui";

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

  return (
    <div>
      <h1 className="font-display text-lg tracking-widest">运营看板</h1>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="注册用户" value={data.userCount} />
        <Stat label="今日解锁" value={data.todayUnlocks} accent />
        <Stat label="今日发放积分" value={data.todayPoints?.granted ?? 0} />
        <Stat label="今日消耗积分" value={data.todayPoints?.spent ?? 0} />
        <Stat label="历史样本库" value={data.historyCount.toLocaleString()} sub="场赛果" />
      </div>

      <h2 className="font-display mt-8 text-sm tracking-widest text-muted">比赛状态分布</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {data.statusCounts.map((s) => (
          <span key={s.status} className="rounded border border-hairline bg-surface px-3 py-1.5 text-[12px] text-muted">
            {s.status} <b className="text-ink">{s.n}</b>
          </span>
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

      <h2 className="font-display mt-8 text-sm tracking-widest text-muted">手动触发任务</h2>
      <div className="mt-2 flex gap-2">
        {["state_machine", "live_revisions", "fetch_results"].map((j) => (
          <button key={j} onClick={() => runJob(j)} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted hover:border-gold/50 hover:text-gold-bright">
            {j}
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
