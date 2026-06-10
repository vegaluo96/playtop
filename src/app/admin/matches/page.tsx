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
    // 支持从看板带筛选跳入：/admin/matches?f=ready
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

  const filtered = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-lg tracking-widest">比赛管理</h1>
        <div className="flex gap-2">
          <button onClick={importFixtures} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted hover:text-gold-bright">
            从 CSV 导入赛程（俱乐部联赛）
          </button>
          <button onClick={() => setShowCreate(!showCreate)} className="rounded border border-gold/50 px-3 py-1.5 text-[12px] text-gold-bright">
            手动建赛（世界杯/杯赛）
          </button>
        </div>
      </div>
      {msg && <p className="mt-2 break-all rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      {showCreate && (
        <div className="card mt-3 grid grid-cols-1 gap-3 p-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">联赛代码（如 WC2026 / INT）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.leagueCode} onChange={(e) => setForm({ ...form, leagueCode: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">国家/地区（队名归一用，国家队填"国际"）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">主队（须与历史库同名，如 Argentina）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.homeName} onChange={(e) => setForm({ ...form, homeName: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">客队</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.awayName} onChange={(e) => setForm({ ...form, awayName: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">开球时间（本地时区）</span>
            <input type="datetime-local" className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.kickoff} onChange={(e) => setForm({ ...form, kickoff: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">场馆/城市（喂天气与地理编码）</span>
            <input className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={form.venue} onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[10px] tracking-widest text-faint">轮次</span>
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

      <div className="mt-4 flex flex-wrap gap-1.5">
        {["all", ...Object.keys(STATUS_LABEL)].map((st) => (
          <button key={st} onClick={() => setFilter(st)} className={`rounded-full border px-2.5 py-1 text-[11px] ${filter === st ? "border-gold/60 text-gold-bright" : "border-hairline text-faint"}`}>
            {st === "all" ? "全部" : STATUS_LABEL[st]?.text ?? st}
          </button>
        ))}
      </div>

      <div className="mt-3 overflow-x-auto">
      <table className="tabular w-full min-w-[640px] text-[12.5px]">
        <thead>
          <tr className="text-left text-[10px] tracking-widest text-faint">
            <th className="pb-2 font-normal">ID</th>
            <th className="pb-2 font-normal">赛事</th>
            <th className="pb-2 font-normal">对阵</th>
            <th className="pb-2 font-normal">开球</th>
            <th className="pb-2 font-normal">状态</th>
            <th className="pb-2 font-normal">价格</th>
            <th className="pb-2 font-normal">来源</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => {
            const s = STATUS_LABEL[r.status] ?? { text: r.status, tone: "default" as const };
            return (
              <tr key={r.id} className="border-t border-hairline hover:bg-overlay/40">
                <td className="py-2 text-faint">#{r.id}</td>
                <td className="py-2 text-muted">
                  {r.league}
                  {r.round ? ` · ${r.round}` : ""}
                </td>
                <td className="py-2">
                  <Link href={`/admin/matches/${r.id}`} className="text-ink underline-offset-4 hover:text-gold-bright hover:underline">
                    {r.homeName} vs {r.awayName}
                  </Link>
                  {r.neutral === 1 && <span className="ml-1 text-[10px] text-faint">中立</span>}
                </td>
                <td className="py-2 text-muted">{fmtTs(r.kickoffAt)}</td>
                <td className="py-2">
                  <Tag tone={s.tone}>{s.text}</Tag>
                </td>
                <td className="py-2 text-muted">{r.pricePoints ?? "—"}</td>
                <td className="py-2 text-faint">{r.source}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {filtered.length === 0 && <p className="mt-6 text-center text-[12px] text-faint">无匹配比赛</p>}
    </div>
  );
}
