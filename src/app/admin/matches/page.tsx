"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { STATUS_LABEL, Tag } from "@/components/ui";

interface MatchRow {
  id: number;
  league: string;
  homeName: string;
  awayName: string;
  kickoffAt: number;
  status: string;
  source: string;
  pricePoints: number | null;
  neutral: number;
  round: string | null;
}

/** 运营阶段分组：内部状态机对运营者太细，按"人话阶段"折叠 */
const STAGE_GROUPS: { key: string; label: string; statuses: string[] }[] = [
  { key: "all", label: "全部", statuses: [] },
  { key: "pre", label: "赛前流水线", statuses: ["scheduled", "collecting", "ready", "analyzed"] },
  { key: "published", label: "已发布", statuses: ["published"] },
  { key: "in_play", label: "进行中", statuses: ["in_play"] },
  { key: "finished", label: "待结算", statuses: ["finished"] },
  { key: "settled", label: "已公开", statuses: ["settled"] },
  { key: "void", label: "作废", statuses: ["void"] },
];

function untilKickoff(t: number): string {
  const m = Math.round((t - Date.now()) / 60_000);
  if (m <= 0) return "已开球";
  if (m < 60) return `${m} 分钟后`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)} 小时后`;
  return `${Math.round(m / 60 / 24)} 天后`;
}

export default function AdminMatches() {
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [msg, setMsg] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    leagueCode: "WC2026",
    country: "国际",
    homeName: "",
    awayName: "",
    kickoff: "",
    venue: "",
    round: "小组赛",
    neutral: true,
  });

  const load = () => api<MatchRow[]>("/api/admin/matches").then(setRows).catch((e) => setMsg(e.message));
  useEffect(() => {
    // 支持从值班台带筛选跳入：?f=ready（原始状态）或 ?f=pre（阶段组）
    const f = new URLSearchParams(window.location.search).get("f");
    if (f) setFilter(f);
    void load();
  }, []);

  async function importFixtures() {
    setMsg("正在从 fixtures.csv 导入赛程…");
    try {
      const r = await api("/api/admin/matches/import", { method: "POST" });
      setMsg(`✓ 导入完成：${JSON.stringify(r)}`);
      void load();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    }
  }

  async function importWorldCup() {
    setMsg("正在从 openfootball 导入世界杯 2026 赛程（队名/中立场/场馆/时区自动处理）…");
    try {
      const r = await api<{ created: number; updated: number; unchanged: number; pendingKnockout: number; pastSkipped: number }>(
        "/api/admin/matches/import-worldcup",
        { method: "POST" },
      );
      setMsg(
        `✓ 世界杯导入完成：新建 ${r.created} 场，更新 ${r.updated} 场，已存在 ${r.unchanged} 场，` +
          `淘汰赛待定 ${r.pendingKnockout} 场（对阵确定后每 6 小时自动补建），已过期跳过 ${r.pastSkipped} 场`,
      );
      void load();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    }
  }

  async function createMatch() {
    try {
      const kickoffAt = new Date(form.kickoff).getTime();
      if (!Number.isFinite(kickoffAt)) throw new Error("开球时间格式不正确");
      await api("/api/admin/matches", {
        method: "POST",
        body: JSON.stringify({
          leagueCode: form.leagueCode,
          country: form.country || undefined,
          homeName: form.homeName,
          awayName: form.awayName,
          kickoffAt,
          venue: form.venue || undefined,
          round: form.round || undefined,
          neutral: form.neutral,
        }),
      });
      setShowCreate(false);
      setMsg("✓ 已创建");
      void load();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : e}`);
    }
  }

  const group = STAGE_GROUPS.find((g) => g.key === filter);
  const filtered =
    filter === "all" ? rows : group && group.statuses.length > 0 ? rows.filter((r) => group.statuses.includes(r.status)) : rows.filter((r) => r.status === filter);
  const t = Date.now();
  const upcoming = filtered.filter((r) => r.kickoffAt >= t).sort((a, b) => a.kickoffAt - b.kickoffAt);
  const past = filtered.filter((r) => r.kickoffAt < t).sort((a, b) => b.kickoffAt - a.kickoffAt);

  const renderTable = (list: MatchRow[]) => (
    <div className="mt-2 overflow-x-auto">
      <table className="tabular w-full min-w-[560px] text-[12.5px]">
        <tbody>
          {list.map((r) => {
            const s = STATUS_LABEL[r.status] ?? { text: r.status, tone: "default" as const };
            return (
              <tr key={r.id} className="border-t border-hairline hover:bg-overlay/40">
                <td className="py-2 whitespace-nowrap text-faint">{fmtTs(r.kickoffAt)}</td>
                <td className="py-2 whitespace-nowrap text-muted">{r.kickoffAt >= t ? untilKickoff(r.kickoffAt) : ""}</td>
                <td className="py-2">
                  <Link href={`/admin/matches/${r.id}`} className="text-ink underline-offset-4 hover:text-gold-bright hover:underline">
                    {r.homeName} vs {r.awayName}
                  </Link>
                  {r.neutral === 1 && <span className="ml-1 text-[10px] text-faint">中立</span>}
                </td>
                <td className="py-2 text-faint">
                  {r.league}
                  {r.round ? ` · ${r.round}` : ""}
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
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-lg tracking-wider">比赛管理</h1>
        <span className="text-[10px] text-faint">赛程由调度器每 6 小时自动同步</span>
      </div>
      {msg && <p className="mt-2 break-all rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {STAGE_GROUPS.map((g) => (
          <button
            key={g.key}
            onClick={() => setFilter(g.key)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${filter === g.key ? "border-gold/60 text-gold-bright" : "border-hairline text-faint"}`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {upcoming.length > 0 && (
        <>
          <h2 className="font-display mt-4 text-[12px] tracking-wider text-muted">未开赛（{upcoming.length} 场，按开球时间）</h2>
          {renderTable(upcoming)}
        </>
      )}
      {past.length > 0 && (
        <>
          <h2 className="font-display mt-6 text-[12px] tracking-wider text-muted">已开球 / 历史（{past.length} 场）</h2>
          {renderTable(past)}
        </>
      )}
      {filtered.length === 0 && <p className="mt-6 text-center text-[12px] text-faint">无匹配比赛</p>}

      {/* 兜底工具：日常零人工，仅在自动同步失效或临时建赛时使用 */}
      <details className="mt-8">
        <summary className="font-display cursor-pointer text-[12px] tracking-wider text-faint">▸ 赛程工具（手动导入 / 建赛，日常无需使用）</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={importWorldCup} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">
            导入世界杯 2026
          </button>
          <button onClick={importFixtures} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted hover:text-gold-bright">
            同步联赛赛程（CSV）
          </button>
          <button onClick={() => setShowCreate(!showCreate)} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted hover:text-gold-bright">
            手动建赛
          </button>
        </div>

        {showCreate && (
          <div className="card mt-3 grid grid-cols-1 gap-3 p-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">联赛代码（如 WC2026 / INT）</span>
              <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.leagueCode} onChange={(e) => setForm({ ...form, leagueCode: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">国家/地区（队名归一用，国家队填"国际"）</span>
              <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">主队（须与历史库同名，如 Argentina）</span>
              <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.homeName} onChange={(e) => setForm({ ...form, homeName: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">客队</span>
              <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.awayName} onChange={(e) => setForm({ ...form, awayName: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">开球时间（本地时区）</span>
              <input type="datetime-local" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.kickoff} onChange={(e) => setForm({ ...form, kickoff: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">场馆/城市（喂天气与地理编码）</span>
              <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-[10px] tracking-wider text-faint">轮次</span>
              <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.round} onChange={(e) => setForm({ ...form, round: e.target.value })} />
            </label>
            <label className="mt-5 flex items-center gap-2 text-[12px] text-muted">
              <input type="checkbox" checked={form.neutral} onChange={(e) => setForm({ ...form, neutral: e.target.checked })} />
              中立场（世界杯非东道主场次勾选）
            </label>
            <div className="sm:col-span-2 lg:col-span-4">
              <button onClick={createMatch} className="rounded border border-gold/50 px-4 py-1.5 text-[12px] text-gold-bright">创建</button>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
