"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { api, fmtTs } from "@/components/admin/api";
import { MARKET_LABEL, STATUS_LABEL, Tag, pct } from "@/components/ui";

interface ThreeWayN {
  home: number;
  draw: number;
  away: number;
}

interface EngineView {
  fallbackLevel: number;
  market: {
    rawOdds: ThreeWayN;
    overround: number;
    devigged: ThreeWayN;
    books: { bookmaker: string; rawOdds: ThreeWayN; overround: number; devigged: ThreeWayN }[];
  } | null;
  dixonColes: { probs: ThreeWayN; topScores: { score: string; prob: number }[] } | null;
  elo: { home: number; away: number; probs: ThreeWayN } | null;
  ensemble: { weights: { market: number; dc: number; elo: number }; probs: ThreeWayN };
  picks: {
    market: string;
    selection: string;
    line: number | null;
    modelProb: number;
    odds: number | null;
    bookmaker?: string;
    ev: number | null;
    kelly: number | null;
    confidence: string;
  }[];
  trace: string[];
}

interface OddsPayload {
  bookmaker?: string;
  oneXTwo?: ThreeWayN;
  ou: { line: number; over: number; under: number }[];
  ah: { line: number; home: number; away: number }[];
  hhad?: { line: number; home: number; draw: number; away: number };
  totalGoals?: Record<string, number>;
  correctScores?: { score: string; odds: number }[];
  capturedAt: number;
}

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
  oddsBooks: { bookmaker: string; source: string; fetchedAt: number; payload: OddsPayload }[];
  oddsHistory: { bookmaker: string; capturedAt: number; oneXTwo: ThreeWayN | null }[];
  latestAnalysis: { id: number; version: number; status: string; engine: EngineView; reportMd: string } | null;
  versions: { id: number; version: number; status: string; publishedAt: number | null; contentHash: string | null; createdAt: number }[];
  outcome: { homeGoals: number; awayGoals: number; finalStatus: string; provisional: number; source: string } | null;
  automation: { autoCollect: boolean; autoAnalyze: boolean; autoPublish: boolean; autoConfirmAiResults: boolean };
}

const PIPELINE = ["scheduled", "collecting", "ready", "analyzed", "published", "in_play", "finished", "settled"];

const KIND_CN: Record<string, string> = {
  injuries: "伤停",
  suspensions: "停赛",
  lineups: "预计阵容",
  coach: "教练",
  referee: "裁判",
  soft_info: "软信息/舆情",
  venue: "场馆",
  weather: "天气",
  manual_override: "人工覆盖",
};

/** 选项中文标签（客户端本地实现，避免引入服务端模块） */
function selLabel(market: string, selection: string, line: number | null): string {
  if (market === "1x2") return { home: "主胜", draw: "平局", away: "客胜" }[selection] ?? selection;
  if (market === "ou") return `${selection === "over" ? "大" : "小"} ${line ?? ""}`;
  if (market === "ah") return `${selection === "home" ? "主" : "客"} ${line !== null && line > 0 ? `+${line}` : (line ?? "")}`;
  return selection;
}

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
    // 工作台实时轮询：调度器在后台自动推进，页面 30s 自动反映最新状态
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => clearInterval(timer);
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
  const engine = wb.latestAnalysis?.engine ?? null;

  const collect = (skipAi: boolean) =>
    act(skipAi ? "采集（跳过 AI）" : "全维度采集", () =>
      api(`/api/admin/matches/${m.id}/collect`, { method: "POST", body: skipAi ? JSON.stringify({ skipAi: true }) : "{}" }),
    );
  const advance = () => act("立即推进", () => api(`/api/admin/matches/${m.id}/advance`, { method: "POST", body: "{}" }));
  const analyze = () => act("引擎建模", () => api(`/api/admin/matches/${m.id}/analyze`, { method: "POST", body: "{}" }));
  const publish = (analysisId: number) =>
    act("发布", () =>
      api(`/api/admin/analyses/${analysisId}/publish`, {
        method: "POST",
        body: JSON.stringify(price.trim() === "" ? {} : { pricePoints: Number(price) }),
      }),
    );
  const confirmOutcome = () =>
    act("确认赛果", () => api(`/api/admin/matches/${m.id}/outcome`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }));

  /** 状态 → 自动化语境下的当前阶段说明 */
  function stage(): { title: string; desc: string } {
    const a = wb!.automation;
    switch (m.status) {
      case "scheduled":
      case "collecting":
        return {
          title: "阶段 1 · 数据采集",
          desc: a.autoCollect
            ? "调度器每 30 分钟自动采集（盘口多源：竞彩 / Polymarket / AI 多家报价；CSV 联赛另有官方源）。可点「立即推进」加速。"
            : "自动采集已关闭：点「采集」手动抓取。",
        };
      case "ready":
        return {
          title: "阶段 2 · 建模",
          desc: a.autoAnalyze ? "数据就绪，调度器将自动运行引擎；「立即推进」可马上建模。" : "自动建模已关闭：点「运行引擎」手动建模。",
        };
      case "analyzed":
        return {
          title: "阶段 3 · 发布",
          desc: a.autoPublish
            ? "草稿已生成，调度器将按默认价自动发布；发布前可在下方审查模型输出与报告预览，「立即推进」可马上发布。"
            : "自动发布已关闭：审阅草稿后手动点「发布」。",
        };
      case "published":
        return { title: "✓ 已发布 · 实时改版中", desc: "每 30 分钟自动重采集→重算→数据变化即发新版；开赛自动锁定终版。" };
      case "in_play":
        return {
          title: "比赛进行中",
          desc: a.autoConfirmAiResults
            ? "完场后每 2 小时 AI 检索赛果，两次检索同比分即自动确认结算（结算前可人工纠正）。"
            : "完场后等待人工录入/确认赛果。",
        };
      case "finished":
        return wb!.outcome && wb!.outcome.provisional === 1
          ? { title: "阶段 4 · 赛果待确认", desc: `AI 检索到 ${wb!.outcome.homeGoals}:${wb!.outcome.awayGoals}（待二次核验/人工确认）。` }
          : { title: "阶段 4 · 待结算", desc: "赛果已确认，状态机 10 分钟内自动结算公开。" };
      case "settled":
        return { title: "✓ 流程完成", desc: "已结算并免费公开，战绩已更新。" };
      case "void":
        return { title: "已作废", desc: "本场已作废并全额退款，不计战绩。" };
      default:
        return { title: m.status, desc: "" };
    }
  }
  const st = stage();
  const canAdvance = ["scheduled", "collecting", "ready", "analyzed", "published"].includes(m.status);

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

  const oddsInput = "rounded border border-hairline bg-overlay/50 px-2 py-1.5";
  const best = (sel: keyof ThreeWayN): number =>
    Math.max(...wb.oddsBooks.map((b) => b.payload.oneXTwo?.[sel] ?? 0));

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg tracking-wide">
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
      <div className="mt-4 flex flex-wrap items-center gap-1">
        {PIPELINE.map((stt, i) => {
          const reached = PIPELINE.indexOf(m.status) >= i && m.status !== "void";
          return (
            <div key={stt} className="flex items-center gap-1">
              <span className={`rounded px-2 py-1 text-[10px] tracking-wider ${reached ? "bg-gold/20 text-gold-bright" : "bg-overlay text-faint"}`}>
                {STATUS_LABEL[stt]?.text ?? stt}
              </span>
              {i < PIPELINE.length - 1 && <span className="text-faint">›</span>}
            </div>
          );
        })}
        {m.status === "void" && <Tag tone="down">已作废</Tag>}
      </div>

      {/* 自动化状态横幅 */}
      <div className="card mt-3 flex flex-wrap items-center gap-3 border-gold/30 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-display text-[13px] tracking-wide text-gold-bright">{st.title}</div>
          <p className="mt-0.5 text-[11.5px] leading-5 text-muted">{st.desc}</p>
        </div>
        {canAdvance && (
          <button
            disabled={busy}
            onClick={advance}
            className="shrink-0 rounded border border-gold/60 bg-gold/10 px-4 py-2 text-[12px] font-semibold text-gold-bright disabled:opacity-50"
          >
            立即推进
          </button>
        )}
      </div>

      {msg && <p className="mt-3 break-all rounded border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">{msg}</p>}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 左列：数据 */}
        <section className="space-y-4">
          {/* 多书商盘口对照 */}
          <div className="card p-4">
            <h2 className="font-display text-sm tracking-wide text-gold-bright">多书商盘口对照（{wb.oddsBooks.length} 家）</h2>
            {wb.oddsBooks.length === 0 ? (
              <p className="mt-2 text-[11px] text-faint">尚无盘口数据。采集会自动拉取竞彩 / Polymarket / AI 多家报价。</p>
            ) : (
              <table className="tabular mt-3 w-full text-[11.5px]">
                <thead>
                  <tr className="text-left text-[10px] tracking-wider text-faint">
                    <th className="pb-1 font-normal">书商</th>
                    <th className="pb-1 text-right font-normal">主胜</th>
                    <th className="pb-1 text-right font-normal">平局</th>
                    <th className="pb-1 text-right font-normal">客胜</th>
                    <th className="pb-1 text-right font-normal">大小</th>
                    <th className="pb-1 text-right font-normal">亚盘</th>
                    <th className="pb-1 text-right font-normal">让球</th>
                    <th className="pb-1 text-right font-normal">花式</th>
                    <th className="pb-1 text-right font-normal">更新</th>
                  </tr>
                </thead>
                <tbody>
                  {wb.oddsBooks.map((b) => {
                    const o = b.payload.oneXTwo;
                    const ou = b.payload.ou[0];
                    const ah = b.payload.ah[0];
                    const hh = b.payload.hhad;
                    const extras = [
                      b.payload.totalGoals ? "总进球" : null,
                      b.payload.correctScores?.length ? `波胆×${b.payload.correctScores.length}` : null,
                    ].filter(Boolean);
                    return (
                      <tr key={b.bookmaker} className="border-t border-hairline">
                        <td className="py-1.5">{b.bookmaker}</td>
                        {(["home", "draw", "away"] as const).map((sel) => (
                          <td key={sel} className={`py-1.5 text-right ${o && o[sel] === best(sel) && wb.oddsBooks.length > 1 ? "font-semibold text-up" : ""}`}>
                            {o ? o[sel].toFixed(2) : "—"}
                          </td>
                        ))}
                        <td className="py-1.5 text-right text-muted">{ou ? `${ou.line} (${ou.over.toFixed(2)}/${ou.under.toFixed(2)})` : "—"}</td>
                        <td className="py-1.5 text-right text-muted">{ah ? `${ah.line > 0 ? "+" : ""}${ah.line} (${ah.home.toFixed(2)}/${ah.away.toFixed(2)})` : "—"}</td>
                        <td className="py-1.5 text-right text-muted">{hh ? `${hh.line > 0 ? "+" : ""}${hh.line} (${hh.home.toFixed(2)}/${hh.draw.toFixed(2)}/${hh.away.toFixed(2)})` : "—"}</td>
                        <td className="py-1.5 text-right text-faint">{extras.length ? extras.join(" ") : "—"}</td>
                        <td className="py-1.5 text-right text-faint">{fmtTs(b.fetchedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {wb.oddsBooks.length > 1 && <p className="mt-2 text-[10px] text-faint">绿色 = 该方向跨家最优价（价值扫描即按此口径计算）。</p>}
          </div>

          {/* 数据快照 */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm tracking-wide text-gold-bright">数据快照（{wb.snapshots.total} 份）</h2>
              <div className="flex gap-2">
                <button disabled={busy} onClick={() => collect(false)} className="rounded border border-gold/50 px-2.5 py-1 text-[11px] text-gold-bright disabled:opacity-50">
                  采集（含 AI）
                </button>
                <button disabled={busy} onClick={() => collect(true)} className="rounded border border-hairline px-2.5 py-1 text-[11px] text-muted disabled:opacity-50">
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

            <details className="mt-4">
              <summary className="cursor-pointer text-[11px] tracking-wider text-faint">▸ 手动录入盘口（自动源全部失败时的兜底）</summary>
              <div className="tabular mt-2 space-y-2 text-[12px]">
                <div>
                  <div className="mb-1 text-[10px] tracking-wider text-faint">胜平负（1X2）</div>
                  <div className="grid grid-cols-3 gap-2">
                    <input placeholder="主胜赔率" className={oddsInput} value={odds.home} onChange={(e) => setOdds({ ...odds, home: e.target.value })} />
                    <input placeholder="平局赔率" className={oddsInput} value={odds.draw} onChange={(e) => setOdds({ ...odds, draw: e.target.value })} />
                    <input placeholder="客胜赔率" className={oddsInput} value={odds.away} onChange={(e) => setOdds({ ...odds, away: e.target.value })} />
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] tracking-wider text-faint">大小球（选填）</div>
                  <div className="grid grid-cols-3 gap-2">
                    <input placeholder="盘口（如 2.5）" className={oddsInput} value={odds.ouLine} onChange={(e) => setOdds({ ...odds, ouLine: e.target.value })} />
                    <input placeholder="大球赔率" className={oddsInput} value={odds.over} onChange={(e) => setOdds({ ...odds, over: e.target.value })} />
                    <input placeholder="小球赔率" className={oddsInput} value={odds.under} onChange={(e) => setOdds({ ...odds, under: e.target.value })} />
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[10px] tracking-wider text-faint">亚盘（选填）</div>
                  <div className="grid grid-cols-3 gap-2">
                    <input placeholder="盘口（主让 -0.5）" className={oddsInput} value={odds.ahLine} onChange={(e) => setOdds({ ...odds, ahLine: e.target.value })} />
                    <input placeholder="主队水位" className={oddsInput} value={odds.ahHome} onChange={(e) => setOdds({ ...odds, ahHome: e.target.value })} />
                    <input placeholder="客队水位" className={oddsInput} value={odds.ahAway} onChange={(e) => setOdds({ ...odds, ahAway: e.target.value })} />
                  </div>
                </div>
              </div>
              <button disabled={busy} onClick={() => act("录入盘口", () => api(`/api/admin/matches/${m.id}/snapshots`, { method: "POST", body: JSON.stringify({ kind: "odds", payload: buildOddsPayload() }) }))} className="mt-2 rounded border border-gold/50 px-3 py-1.5 text-[11px] text-gold-bright disabled:opacity-50">
                保存盘口
              </button>
            </details>

            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] tracking-wider text-faint">▸ 高级：手动录入任意维度（JSON，同归一化校验）</summary>
              <div className="mt-2 flex gap-2">
                <select value={manualKind} onChange={(e) => setManualKind(e.target.value)} className="rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]">
                  {Object.entries(KIND_CN).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}（{k}）
                    </option>
                  ))}
                </select>
              </div>
              <textarea rows={4} className="tabular mt-2 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[11px]" value={manualJson} onChange={(e) => setManualJson(e.target.value)} />
              <button disabled={busy} onClick={() => act("录入快照", () => api(`/api/admin/matches/${m.id}/snapshots`, { method: "POST", body: JSON.stringify({ kind: manualKind, payload: JSON.parse(manualJson) }) }))} className="mt-1 rounded border border-hairline px-3 py-1.5 text-[11px] text-muted disabled:opacity-50">
                写入快照
              </button>
            </details>
          </div>
        </section>

        {/* 右列：模型输出 / 发布 / 赛果 */}
        <section className="space-y-4">
          {/* 模型输出（含草稿——发布前即可审查） */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm tracking-wide text-gold-bright">
                模型输出{wb.latestAnalysis ? `（V${wb.latestAnalysis.version} · ${wb.latestAnalysis.status === "draft" ? "草稿" : wb.latestAnalysis.status}）` : ""}
              </h2>
              <button disabled={busy} onClick={analyze} className="rounded border border-hairline px-2.5 py-1 text-[11px] text-muted disabled:opacity-50">
                重新建模
              </button>
            </div>
            {!engine ? (
              <p className="mt-2 text-[11px] text-faint">尚未建模。数据就绪后由调度器自动建模，或点「立即推进」。</p>
            ) : (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <Tag tone="info">退化等级 L{engine.fallbackLevel}</Tag>
                  <Tag>
                    集成 主{pct(engine.ensemble.probs.home)}/平{pct(engine.ensemble.probs.draw)}/客{pct(engine.ensemble.probs.away)}
                  </Tag>
                </div>
                <table className="tabular mt-3 w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-[10px] tracking-wider text-faint">
                      <th className="pb-1 font-normal">信息源</th>
                      <th className="pb-1 text-right font-normal">主胜</th>
                      <th className="pb-1 text-right font-normal">平局</th>
                      <th className="pb-1 text-right font-normal">客胜</th>
                      <th className="pb-1 text-right font-normal">权重</th>
                    </tr>
                  </thead>
                  <tbody>
                    {engine.market?.books.map((b) => (
                      <tr key={b.bookmaker} className="border-t border-hairline text-muted">
                        <td className="py-1">「{b.bookmaker}」去水（水位 {pct(b.overround)}）</td>
                        <td className="py-1 text-right">{pct(b.devigged.home)}</td>
                        <td className="py-1 text-right">{pct(b.devigged.draw)}</td>
                        <td className="py-1 text-right">{pct(b.devigged.away)}</td>
                        <td className="py-1 text-right">—</td>
                      </tr>
                    ))}
                    {engine.market && (
                      <tr className="border-t border-hairline">
                        <td className="py-1">市场共识（{engine.market.books.length} 家中位数）</td>
                        <td className="py-1 text-right">{pct(engine.market.devigged.home)}</td>
                        <td className="py-1 text-right">{pct(engine.market.devigged.draw)}</td>
                        <td className="py-1 text-right">{pct(engine.market.devigged.away)}</td>
                        <td className="py-1 text-right text-muted">{pct(engine.ensemble.weights.market)}</td>
                      </tr>
                    )}
                    {engine.dixonColes && (
                      <tr className="border-t border-hairline">
                        <td className="py-1">Dixon-Coles</td>
                        <td className="py-1 text-right">{pct(engine.dixonColes.probs.home)}</td>
                        <td className="py-1 text-right">{pct(engine.dixonColes.probs.draw)}</td>
                        <td className="py-1 text-right">{pct(engine.dixonColes.probs.away)}</td>
                        <td className="py-1 text-right text-muted">{pct(engine.ensemble.weights.dc)}</td>
                      </tr>
                    )}
                    {engine.elo && (
                      <tr className="border-t border-hairline">
                        <td className="py-1">
                          Elo（{engine.elo.home.toFixed(0)} vs {engine.elo.away.toFixed(0)}）
                        </td>
                        <td className="py-1 text-right">{pct(engine.elo.probs.home)}</td>
                        <td className="py-1 text-right">{pct(engine.elo.probs.draw)}</td>
                        <td className="py-1 text-right">{pct(engine.elo.probs.away)}</td>
                        <td className="py-1 text-right text-muted">{pct(engine.ensemble.weights.elo)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {engine.picks.length > 0 ? (
                  <table className="tabular mt-3 w-full text-[11px]">
                    <thead>
                      <tr className="text-left text-[10px] tracking-wider text-faint">
                        <th className="pb-1 font-normal">观点</th>
                        <th className="pb-1 text-right font-normal">概率</th>
                        <th className="pb-1 text-right font-normal">赔率</th>
                        <th className="pb-1 text-right font-normal">出处</th>
                        <th className="pb-1 text-right font-normal">期望收益</th>
                        <th className="pb-1 text-right font-normal">模拟单位</th>
                        <th className="pb-1 text-right font-normal">信心</th>
                      </tr>
                    </thead>
                    <tbody>
                      {engine.picks.map((p, i) => (
                        <tr key={i} className="border-t border-hairline">
                          <td className="py-1">
                            {MARKET_LABEL[p.market]}·{selLabel(p.market, p.selection, p.line)}
                          </td>
                          <td className="py-1 text-right">{pct(p.modelProb)}</td>
                          <td className="py-1 text-right">{p.odds?.toFixed(2) ?? "—"}</td>
                          <td className="py-1 text-right text-muted">{p.bookmaker ?? "—"}</td>
                          <td className={`py-1 text-right ${p.ev !== null && p.ev > 0 ? "text-up" : "text-muted"}`}>
                            {p.ev === null ? "—" : `${p.ev >= 0 ? "+" : ""}${pct(p.ev)}`}
                          </td>
                          <td className="py-1 text-right">{p.kelly ? pct(p.kelly) : "—"}</td>
                          <td className="py-1 text-right text-gold-bright">{p.confidence}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="mt-2 text-[11px] text-muted">本场模型结论：观望（无足够价值偏差）。</p>
                )}

                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] tracking-wider text-faint">▸ 计算过程（{engine.trace.length} 条审计轨迹）</summary>
                  <ul className="tabular mt-2 max-h-72 space-y-1 overflow-y-auto border-l border-hairline pl-3 text-[10.5px] leading-5 text-muted">
                    {engine.trace.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </details>

                {wb.latestAnalysis && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] tracking-wider text-faint">▸ 报告预览（发布前全文）</summary>
                    <pre className="mt-2 max-h-96 overflow-y-auto rounded border border-hairline bg-overlay/40 p-3 text-[11px] leading-5 whitespace-pre-wrap text-muted">
                      {wb.latestAnalysis.reportMd}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>

          {/* 版本与发布 */}
          <div className="card p-4">
            <h2 className="font-display text-sm tracking-wide text-gold-bright">版本与发布</h2>
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
                          <button disabled={busy} onClick={() => publish(v.id)} className="text-[11px] text-gold-bright underline underline-offset-2 disabled:opacity-50">
                            发布
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {wb.versions.length === 0 && <p className="mt-2 text-[11px] text-faint">尚未建模。</p>}
            <div className="mt-3 flex items-center gap-2 text-[12px]">
              <span className="text-faint">解锁价（积分，留空用默认价）</span>
              <input className="tabular w-24 rounded border border-hairline bg-overlay/50 px-2 py-1" value={price} onChange={(e) => setPrice(e.target.value)} />
              <button disabled={busy} onClick={() => act("保存价格", () => api(`/api/admin/matches/${m.id}`, { method: "PUT", body: JSON.stringify({ pricePoints: Number(price) }) }))} className="rounded border border-hairline px-2.5 py-1 text-[11px] text-muted disabled:opacity-50">
                保存
              </button>
            </div>
          </div>

          {draft && (
            <div className="card p-4">
              <h2 className="font-display text-sm tracking-wide text-gold-bright">编辑草稿定性段落（V 草稿 #{draft.id}）</h2>
              <label className="mt-2 block text-[10px] tracking-wider text-faint">核心论点</label>
              <textarea rows={3} className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]" value={draft.thesis} onChange={(e) => setDraft({ ...draft, thesis: e.target.value })} />
              <label className="mt-2 block text-[10px] tracking-wider text-faint">关键驱动（每行一条）</label>
              <textarea rows={4} className="mt-1 w-full rounded border border-hairline bg-overlay/50 px-2 py-1.5 text-[12px]" value={draft.drivers} onChange={(e) => setDraft({ ...draft, drivers: e.target.value })} />
              <label className="mt-2 block text-[10px] tracking-wider text-faint">风险提示（每行一条）</label>
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
            <h2 className="font-display text-sm tracking-wide text-gold-bright">赛果与结算</h2>
            {wb.outcome && (
              <p className="tabular mt-2 text-[12px] text-muted">
                当前赛果：{wb.outcome.homeGoals}:{wb.outcome.awayGoals}（{wb.outcome.source}
                {wb.outcome.provisional === 1 ? " · 待确认" : " · 已确认"}）
                {wb.outcome.provisional === 1 && (
                  <button disabled={busy} onClick={confirmOutcome} className="ml-2 rounded border border-up/50 px-2 py-0.5 text-[11px] text-up disabled:opacity-50">
                    确认并结算
                  </button>
                )}
              </p>
            )}
            <p className="mt-2 text-[10.5px] text-faint">人工录入即时生效且优先级最高（90 分钟常规时间比分，含补时，不含加时点球）。</p>
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
