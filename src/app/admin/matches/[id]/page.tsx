"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { STATUS_LABEL, Tag } from "@/components/ui";

interface Workbench {
  match: {
    id: number;
    league: string;
    homeName: string;
    awayName: string;
    kickoffAt: number;
    venue: string | null;
    neutral: number;
    round: string | null;
    status: string;
    pricePoints: number | null;
    source: string;
    finalAnalysisId: number | null;
  };
  snapshots: {
    perKind: { kind: string; kindLabel: string; source: string; fetchedAt: number; count: number }[];
    missing: string[];
    total: number;
  };
  latestPayloads: Record<string, { id: number; source: string; fetchedAt: number; payload: unknown }>;
  versions: { id: number; version: number; status: string; publishedAt: number | null; contentHash: string | null; createdAt: number }[];
  outcome: { homeGoals: number; awayGoals: number; finalStatus: string; provisional: number; source: string } | null;
}

const PIPELINE = ["scheduled", "collecting", "ready", "analyzed", "published", "in_play", "finished", "settled"];

export default function MatchWorkbench({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [wb, setWb] = useState<Workbench | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState<string>("");
  const [odds, setOdds] = useState({ home: "", draw: "", away: "", over: "", under: "", ouLine: "2.5", ahLine: "", ahHome: "", ahAway: "" });
  const [manualKind, setManualKind] = useState("soft_info");
  const [manualJson, setManualJson] = useState('{"items":[{"topic":"","content":""}]}');
  const [score, setScore] = useState({ home: "", away: "" });
  const [draft, setDraft] = useState<{ id: number; thesis: string; drivers: string; risks: string } | null>(null);

  const load = useCallback(
    () =>
      api<Workbench>(`/api/admin/matches/${id}`)
        .then((d) => {
          setWb(d);
          setPrice(String(d.match.pricePoints ?? ""));
        })
        .catch((e) => setMsg(e.message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMsg(`${label}…`);
    try {
      const r = await fn();
      setMsg(`✓ ${label}完成${r ? `：${JSON.stringify(r).slice(0, 400)}` : ""}`);
      await load();
    } catch (e) {
      setMsg(`✗ ${label}失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadDraft(analysisId: number) {
    const a = await api<{ id: number; llmSections: { thesis: string; drivers: string[]; risks: string[] } | null }>(
      `/api/admin/analyses/${analysisId}`,
    );
    setDraft({
      id: a.id,
      thesis: a.llmSections?.thesis ?? "",
      drivers: (a.llmSections?.drivers ?? []).join("\n"),
      risks: (a.llmSections?.risks ?? []).join("\n"),
    });
  }

  if (!wb) return <p className="text-muted">{msg || "加载中…"}</p>;
  const m = wb.match;
  const latestVersion = wb.versions[0];

  function buildOddsPayload() {
    const n = (v: string) => (v.trim() === "" ? null : Number(v));
    const payload: Record<string, unknown> = { bookmaker: "人工录入", capturedAt: Date.now(), ou: [], ah: [] };
    if (n(odds.home) && n(odds.draw) && n(odds.away)) {
      payload.oneXTwo = { home: n(odds.home), draw: n(odds.draw), away: n(odds.away) };
    }
    if (n(odds.over) && n(odds.under)) {
      payload.ou = [{ line: Number(odds.ouLine || "2.5"), over: n(odds.over), under: n(odds.under) }];
    }
    if (odds.ahLine.trim() !== "" && n(odds.ahHome) && n(odds.ahAway)) {
      payload.ah = [{ line: Number(odds.ahLine), home: n(odds.ahHome), away: n(odds.ahAway) }];
    }
    return payload;
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg tracking-widest">
            {m.homeName} vs {m.awayName}
          </h1>
          <p className="mt-1 text-[12px] text-muted">
            {m.league}
            {m.round ? ` · ${m.round}` : ""} · 开球 {fmtTs(m.kickoffAt)} {m.neutral === 1 && "· 中立场"} · 来源 {m.source}
          </p>
        </div>
        <Link href={`/matches/${m.id}`} className="rounded border border-hairline px-3 py-1.5 text-[12px] text-muted hover:text-gold-bright">
          前台预览 →
        </Link>
      </div>

      {/* 状态机进度 */}
      <div className="mt-4 flex items-center gap-1">
        {PIPELINE.map((st, i) => {
          const reached = PIPELINE.indexOf(m.status) >= i && m.status !== "void";
          return (
            <div key={st} className="flex items-center gap-1">
              <span className={`rounded px-2 py-1 text-[10px] tracking-wider ${reached ? "bg-gold/20 text-gold-bright" : "bg-overlay text-faint"}`}>
                {STATUS_LABEL[st]?.text ?? st}
              </span>
              {i < PIPELINE.length - 1 && <span className="text-faint">›</span>}
            </div>
          );
        })}
        {m.status === "void" && <Tag tone="down">已作废</Tag>}
      </div>

      {msg && <p className="mt-3 break-all rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 左列：数据采集 */}
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm tracking-widest text-gold-bright">数据快照（{wb.snapshots.total} 份）</h2>
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => act("全维度采集", () => api(`/api/admin/matches/${m.id}/collect`, { method: "POST", body: "{}" }))} className="rounded border border-gold/50 px-2.5 py-1 text-[11px] text-gold-bright disabled:opacity-50">
                采集（含 AI）
              </button>
              <button disabled={busy} onClick={() => act("采集（跳过 AI）", () => api(`/api/admin/matches/${m.id}/collect`, { method: "POST", body: JSON.stringify({ skipAi: true }) }))} className="rounded border border-hairline px-2.5 py-1 text-[11px] text-muted disabled:opacity-50">
                采集（跳过 AI）
              </button>
            </div>
          </div>
          <table className="tabular mt-3 w-full text-[11.5px]">
            <tbody>
              {wb.snapshots.perKind.map((s) => (
                <tr key={s.kind} className="border-t border-hairline">
                  <td className="py-1.5">{s.kindLabel}</td>
                  <td className="py-1.5 text-faint">{s.source}</td>
                  <td className="py-1.5 text-right text-muted">×{s.count}</td>
                  <td className="py-1.5 text-right text-faint">{fmtTs(s.fetchedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {wb.snapshots.missing.length > 0 && (
            <p className="mt-2 text-[11px] text-faint">缺失：{wb.snapshots.missing.join("、")}</p>
          )}

          <h3 className="font-display mt-5 text-[12px] tracking-widest text-muted">手动录入盘口（无 CSV 覆盖的赛事）</h3>
          <div className="tabular mt-2 grid grid-cols-3 gap-2 text-[12px]">
            {(["home", "draw", "away"] as const).map((k) => (
              <input key={k} placeholder={{ home: "主胜赔率", draw: "平局赔率", away: "客胜赔率" }[k]} className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds[k]} onChange={(e) => setOdds({ ...odds, [k]: e.target.value })} />
            ))}
            <input placeholder="大小盘口 2.5" className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds.ouLine} onChange={(e) => setOdds({ ...odds, ouLine: e.target.value })} />
            <input placeholder="大球赔率" className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds.over} onChange={(e) => setOdds({ ...odds, over: e.target.value })} />
            <input placeholder="小球赔率" className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds.under} onChange={(e) => setOdds({ ...odds, under: e.target.value })} />
            <input placeholder="亚盘（主让 -0.5）" className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds.ahLine} onChange={(e) => setOdds({ ...odds, ahLine: e.target.value })} />
            <input placeholder="主队水位" className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds.ahHome} onChange={(e) => setOdds({ ...odds, ahHome: e.target.value })} />
            <input placeholder="客队水位" className="rounded border border-hairline bg-overlay/50 px-2 py-1.5" value={odds.ahAway} onChange={(e) => setOdds({ ...odds, ahAway: e.target.value })} />
          </div>
          <button disabled={busy} onClick={() => act("录入盘口", () => api(`/api/admin/matches/${m.id}/snapshots`, { method: "POST", body: JSON.stringify({ kind: "odds", payload: buildOddsPayload() }) }))} className="mt-2 rounded border border-gold/50 px-3 py-1.5 text-[11px] text-gold-bright disabled:opacity-50">
            写入 odds 快照
          </button>

          <h3 className="font-display mt-5 text-[12px] tracking-widest text-muted">手动录入任意维度（JSON，同归一化校验）</h3>
          <div className="mt-2 flex gap-2">
            <select value={manualKind} onChange={(e) => setManualKind(e.target.value)} className="rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]">
              {["injuries", "suspensions", "lineups", "coach", "referee", "soft_info", "venue", "weather", "manual_override"].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <textarea rows={4} className="tabular mt-2 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[11px]" value={manualJson} onChange={(e) => setManualJson(e.target.value)} />
          <button disabled={busy} onClick={() => act("录入快照", () => api(`/api/admin/matches/${m.id}/snapshots`, { method: "POST", body: JSON.stringify({ kind: manualKind, payload: JSON.parse(manualJson) }) }))} className="mt-1 rounded border border-hairline px-3 py-1.5 text-[11px] text-muted disabled:opacity-50">
            写入快照
          </button>
        </section>

        {/* 右列：建模/发布/赛果 */}
        <section className="space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm tracking-widest text-gold-bright">建模与发布</h2>
              <button disabled={busy} onClick={() => act("引擎建模", () => api(`/api/admin/matches/${m.id}/analyze`, { method: "POST", body: "{}" }))} className="rounded border border-gold/50 px-2.5 py-1 text-[11px] text-gold-bright disabled:opacity-50">
                运行引擎 + 生成报告
              </button>
            </div>
            <table className="tabular mt-3 w-full text-[11.5px]">
              <tbody>
                {wb.versions.map((v) => (
                  <tr key={v.id} className="border-t border-hairline">
                    <td className="py-1.5">V{v.version}</td>
                    <td className="py-1.5">
                      <Tag tone={v.status === "published" ? "gold" : v.status === "public" ? "up" : v.status === "void" ? "down" : "default"}>{v.status}</Tag>
                      {m.finalAnalysisId === v.id && <Tag tone="info">终版·战绩口径</Tag>}
                    </td>
                    <td className="py-1.5 text-faint">{fmtTs(v.publishedAt ?? v.createdAt)}</td>
                    <td className="py-1.5 text-right">
                      {v.status === "draft" && (
                        <>
                          <button onClick={() => void loadDraft(v.id)} className="mr-2 text-[11px] text-muted underline underline-offset-2">
                            编辑
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              act("发布", () =>
                                api(`/api/admin/analyses/${v.id}/publish`, {
                                  method: "POST",
                                  body: JSON.stringify(price.trim() === "" ? {} : { pricePoints: Number(price) }),
                                }),
                              )
                            }
                            className="text-[11px] text-gold-bright underline underline-offset-2 disabled:opacity-50"
                          >
                            发布
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {wb.versions.length === 0 && <p className="mt-2 text-[11px] text-faint">尚未建模。先确保数据就绪（ready），再运行引擎。</p>}
            <div className="mt-3 flex items-center gap-2 text-[12px]">
              <span className="text-faint">解锁价（积分）</span>
              <input className="tabular w-24 rounded border border-hairline bg-overlay/50 px-2 py-1" value={price} onChange={(e) => setPrice(e.target.value)} />
              <button disabled={busy} onClick={() => act("保存价格", () => api(`/api/admin/matches/${m.id}`, { method: "PUT", body: JSON.stringify({ pricePoints: Number(price) }) }))} className="rounded border border-hairline px-2.5 py-1 text-[11px] text-muted disabled:opacity-50">
                保存
              </button>
            </div>
            <p className="mt-2 text-[10.5px] leading-4 text-faint">
              发布后进入实时改版模式：调度器每 30 分钟自动重采集→重算→发布新版本；开赛瞬间锁定终版计入战绩。
            </p>
          </div>

          {draft && (
            <div className="card p-4">
              <h2 className="font-display text-sm tracking-widest text-gold-bright">编辑草稿定性段落（V 草稿 #{draft.id}）</h2>
              <label className="mt-2 block text-[10px] tracking-widest text-faint">核心论点</label>
              <textarea rows={3} className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]" value={draft.thesis} onChange={(e) => setDraft({ ...draft, thesis: e.target.value })} />
              <label className="mt-2 block text-[10px] tracking-widest text-faint">关键驱动（每行一条）</label>
              <textarea rows={4} className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]" value={draft.drivers} onChange={(e) => setDraft({ ...draft, drivers: e.target.value })} />
              <label className="mt-2 block text-[10px] tracking-widest text-faint">风险提示（每行一条）</label>
              <textarea rows={3} className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]" value={draft.risks} onChange={(e) => setDraft({ ...draft, risks: e.target.value })} />
              <button
                disabled={busy}
                onClick={() =>
                  act("保存草稿", () =>
                    api(`/api/admin/analyses/${draft.id}`, {
                      method: "PUT",
                      body: JSON.stringify({
                        thesis: draft.thesis,
                        drivers: draft.drivers.split("\n").filter((x) => x.trim()),
                        risks: draft.risks.split("\n").filter((x) => x.trim()),
                      }),
                    }),
                  )
                }
                className="mt-2 rounded border border-gold/50 px-3 py-1.5 text-[11px] text-gold-bright disabled:opacity-50"
              >
                保存定性段落
              </button>
            </div>
          )}

          <div className="card p-4">
            <h2 className="font-display text-sm tracking-widest text-gold-bright">赛果与结算</h2>
            {wb.outcome && (
              <p className="tabular mt-2 text-[12px] text-muted">
                当前赛果：{wb.outcome.homeGoals}:{wb.outcome.awayGoals}（{wb.outcome.source}
                {wb.outcome.provisional === 1 ? " · 待确认" : " · 已确认"}）
                {wb.outcome.provisional === 1 && (
                  <button disabled={busy} onClick={() => act("确认赛果", () => api(`/api/admin/matches/${m.id}/outcome`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }))} className="ml-2 rounded border border-up/50 px-2 py-0.5 text-[11px] text-up disabled:opacity-50">
                    确认并结算
                  </button>
                )}
              </p>
            )}
            <p className="mt-2 text-[10.5px] text-faint">录入 90 分钟常规时间比分（含伤停补时，不含加时与点球）——与报告及结算口径一致。</p>
            <div className="tabular mt-3 flex items-center gap-2 text-[12px]">
              <input placeholder="主" className="w-16 rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-center" value={score.home} onChange={(e) => setScore({ ...score, home: e.target.value })} />
              <span className="text-faint">:</span>
              <input placeholder="客" className="w-16 rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-center" value={score.away} onChange={(e) => setScore({ ...score, away: e.target.value })} />
              <button
                disabled={busy}
                onClick={() =>
                  act("录入赛果并结算", () =>
                    api(`/api/admin/matches/${m.id}/outcome`, {
                      method: "POST",
                      body: JSON.stringify({ action: "record", homeGoals: Number(score.home), awayGoals: Number(score.away) }),
                    }),
                  )
                }
                className="rounded border border-gold/50 px-3 py-1.5 text-[11px] text-gold-bright disabled:opacity-50"
              >
                录入赛果（立即结算公开）
              </button>
            </div>
            <div className="mt-3 border-t border-hairline pt-3">
              <button
                disabled={busy}
                onClick={() => {
                  const reason = prompt("作废原因（将全额退款）：");
                  if (reason) void act("作废比赛", () => api(`/api/admin/matches/${m.id}/void`, { method: "POST", body: JSON.stringify({ reason }) }));
                }}
                className="rounded border border-down/50 px-3 py-1.5 text-[11px] text-down disabled:opacity-50"
              >
                作废比赛（延期/腰斩，自动退款）
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
