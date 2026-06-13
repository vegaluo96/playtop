/** 后台:分析报告管理。只读诊断默认不触发外部抓取;手动重新生成才走既有报告链路。 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { audit, canWrite, currentAdmin } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";
import { fixtureById, fixturesBetween, kvGet } from "@/server/af/store";
import { isFinished, isLive } from "@/server/af/schedule";
import { marketOverview } from "@/server/markets/overview";
import { matchPanorama } from "@/server/af/panorama";
import { buildReport, buildReportSummary, type ReportSection } from "@/server/views/report";
import { buildReportSignals } from "@/server/views/report-signals";
import { findPolymarketSignal } from "@/server/external/polymarket";
import { getLlmReport, reportLocked, REPORT_FACTS_VERSION } from "@/server/llm/report";

type SourceState = "ok" | "warn" | "missing" | "skipped";

interface SourceProbe {
  state: SourceState;
  label: string;
  note: string;
  count?: number;
  lastAt?: number | null;
}

interface FixturePayload {
  events?: unknown[];
  statistics?: unknown[];
  lineups?: unknown[];
  players?: unknown[];
  [key: string]: unknown;
}

function asCount(row: unknown): { n: number; m: number | null } {
  const r = (row ?? {}) as { n?: number; m?: number | null };
  return { n: Number(r.n ?? 0), m: r.m == null ? null : Number(r.m) };
}

function parsePayload(payload: string): FixturePayload {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as FixturePayload) : {};
  } catch {
    return {};
  }
}

function parseKvBox<T>(raw: string | null): { at: number | null; data: T | null } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: number; data?: T };
    return { at: parsed.at == null ? null : Number(parsed.at), data: parsed.data ?? null };
  } catch {
    return null;
  }
}

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function source(state: SourceState, label: string, note: string, count?: number, lastAt?: number | null): SourceProbe {
  return { state, label, note, count, lastAt };
}

function statusZh(status: string): string {
  const map: Record<string, string> = {
    NS: "未开赛", TBD: "待定", PST: "延期",
    "1H": "上半场", HT: "中场", "2H": "下半场", ET: "加时", BT: "中断", P: "点球", INT: "中断", LIVE: "进行中",
    FT: "已完场", AET: "加时完", PEN: "点球完", AWD: "判定", WO: "弃赛",
  };
  return map[status] ?? status;
}

function reportSummary(content: string | null | undefined): string {
  if (!content) return "";
  try {
    const sections = JSON.parse(content) as ReportSection[];
    const first = sections.find((s) => Array.isArray(s.ps) && s.ps.length > 0);
    return first?.ps?.[0]?.slice(0, 120) ?? "";
  } catch {
    return "";
  }
}

function polyProbe(fixtureId: number): SourceProbe {
  const row = db().prepare("SELECT v FROM kv WHERE k LIKE ? ORDER BY k DESC LIMIT 1").get(`poly:fx:${fixtureId}:%`) as
    | { v: string }
    | undefined;
  const box = parseKvBox<{ status?: string; note?: string }>(row?.v ?? null);
  if (!box) return source("skipped", "Polymarket", "尚未请求或未命中逐场缓存");
  const status = box.data?.status ?? "unknown";
  if (status === "ok") return source("ok", "Polymarket", box.data?.note ?? "已命中公开预测市场", 1, box.at);
  if (status === "error") return source("warn", "Polymarket", box.data?.note ?? "增强源请求异常", 0, box.at);
  return source("missing", "Polymarket", box.data?.note ?? "暂无本场可精确匹配市场", 0, box.at);
}

function weatherProbe(fixtureId: number): SourceProbe {
  const issue = db()
    .prepare(
      `SELECT error_type, error_reason, severity, created_at
       FROM diagnostic_issues
       WHERE fixture_id = ? AND source = 'WEATHER'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(fixtureId) as { error_type: string; error_reason: string; severity: string; created_at: number } | undefined;
  if (issue) return source(issue.severity === "error" ? "warn" : "missing", "天气", issue.error_reason, 0, issue.created_at);
  return source("skipped", "天气", "天气为按需增强源,当前无逐场成功快照表");
}

function reportRow(fx: ReturnType<typeof fixturesBetween>[number]) {
  const d = db();
  const now = Date.now();
  const started = isLive(fx.status) || isFinished(fx.status) || now >= fx.kickoff_utc;
  const locked = reportLocked(fx.status);
  const cutoffAt = Math.min(now, fx.kickoff_utc - 1);
  const payload = parsePayload(fx.payload);
  const overview = marketOverview(fx.fixture_id, { cutoffAt });
  const pred = asCount(d.prepare("SELECT COUNT(*) n, MAX(captured_at) m FROM predictions_snapshots WHERE fixture_id = ?").get(fx.fixture_id));
  const liveOdds = asCount(d.prepare("SELECT COUNT(*) n, MAX(captured_at) m FROM live_odds_snapshots WHERE fixture_id = ?").get(fx.fixture_id));
  const raw = asCount(d.prepare("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ?").get(fx.fixture_id));
  const latestVersion = d
    .prepare("SELECT ver, content, model, tokens, gen_at, changed FROM report_versions WHERE fixture_id = ? ORDER BY ver DESC LIMIT 1")
    .get(fx.fixture_id) as
    | { ver: number; content: string; model: string; tokens: number; gen_at: number; changed: string }
    | undefined;
  const versionCount = (d.prepare("SELECT COUNT(*) n FROM report_versions WHERE fixture_id = ?").get(fx.fixture_id) as { n: number } | undefined)?.n ?? 0;
  const cache = d.prepare("SELECT content, model, tokens, gen_at FROM report_cache WHERE fixture_id = ?").get(fx.fixture_id) as
    | { content: string; model: string; tokens: number; gen_at: number }
    | undefined;
  const unlocks = (d.prepare("SELECT COUNT(*) n FROM unlocks WHERE fixture_id = ?").get(fx.fixture_id) as { n: number } | undefined)?.n ?? 0;
  const free = !!d.prepare("SELECT 1 FROM free_fixtures WHERE fixture_id = ? LIMIT 1").get(fx.fixture_id);
  const issues = d
    .prepare(
      `SELECT source, endpoint, error_type, error_reason, severity, created_at
       FROM diagnostic_issues
       WHERE fixture_id = ?
       ORDER BY created_at DESC LIMIT 8`,
    )
    .all(fx.fixture_id) as { source: string; endpoint: string; error_type: string; error_reason: string; severity: string; created_at: number }[];

  const lineups = arrLen(payload.lineups);
  const stats = arrLen(payload.statistics);
  const events = arrLen(payload.events);
  const players = arrLen(payload.players);
  const injuries = parseKvBox<unknown[]>(kvGet(`fx:${fx.fixture_id}:injuries`));
  const toKick = fx.kickoff_utc - now;
  const lineupExpected = toKick <= 60 * 60_000;

  const sources = {
    afRaw: raw.n > 0 ? source("ok", "AF raw", "已有原始响应归档", raw.n, raw.m) : source("missing", "AF raw", "暂无原始响应归档"),
    predictions: pred.n > 0 ? source("ok", "predictions", "已有赛前预测快照", pred.n, pred.m) : source("missing", "predictions", "暂无预测快照"),
    oddsAh: overview.markets.ah.series.length > 0
      ? source("ok", "亚盘", overview.markets.ah.reason, overview.markets.ah.selectedBooks, overview.lastUpdated)
      : source("missing", "亚盘", overview.markets.ah.warnings[0] ?? "暂无可展示主线"),
    oddsOu: overview.markets.ou.series.length > 0
      ? source("ok", "大小球", overview.markets.ou.reason, overview.markets.ou.selectedBooks, overview.lastUpdated)
      : source("missing", "大小球", overview.markets.ou.warnings[0] ?? "暂无可展示主线"),
    oddsEu: overview.markets.eu.series.length > 0
      ? source("ok", "胜平负", overview.markets.eu.reason, overview.markets.eu.selectedBooks, overview.lastUpdated)
      : source("missing", "胜平负", overview.markets.eu.warnings[0] ?? "暂无可展示报价"),
    liveOdds: liveOdds.n > 0 ? source("ok", "滚球赔率", "已有滚球快照", liveOdds.n, liveOdds.m) : source(started ? "missing" : "skipped", "滚球赔率", started ? "开赛后暂无滚球快照" : "开赛后更新"),
    events: events > 0 ? source("ok", "赛况事件", "已并入赛事 payload", events, fx.updated_at) : source(started ? "missing" : "skipped", "赛况事件", started ? "开赛后暂无事件" : "开赛后更新"),
    statistics: stats > 0 ? source("ok", "技术统计", "已并入赛事 payload", stats, fx.updated_at) : source(started ? "missing" : "skipped", "技术统计", started ? "开赛后暂无统计" : "开赛后更新"),
    lineups: lineups > 0 ? source("ok", "阵容", "已并入赛事 payload", lineups, fx.updated_at) : source(lineupExpected ? "missing" : "skipped", "阵容", lineupExpected ? "临场阵容暂未入库或暂未公布" : "暂未公布"),
    players: players > 0 ? source("ok", "球员评分", "已并入赛事 payload", players, fx.updated_at) : source(started ? "missing" : "skipped", "球员评分", started ? "开赛后暂无球员评分" : "开赛后更新"),
    injuries: injuries ? source(arrLen(injuries.data) > 0 ? "ok" : "missing", "伤停", arrLen(injuries.data) > 0 ? "已有伤停缓存" : "暂无伤停通报", arrLen(injuries.data), injuries.at) : source("skipped", "伤停", "未请求或无缓存"),
    polymarket: polyProbe(fx.fixture_id),
    weather: weatherProbe(fx.fixture_id),
  };

  const missingInputs = Object.values(sources)
    .filter((s) => s.state === "missing" && !["滚球赔率", "赛况事件", "技术统计", "球员评分"].includes(s.label) || (started && s.state === "missing"))
    .map((s) => `${s.label}:${s.note}`);
  const severe = issues.find((i) => i.severity === "error") ?? issues.find((i) => i.severity === "warn");
  const latest = latestVersion ?? cache;

  return {
    fixtureId: fx.fixture_id,
    leagueId: fx.league_id,
    league: fx.league_name,
    round: fx.round,
    kickoffUtc: fx.kickoff_utc,
    status: fx.status,
    statusText: statusZh(fx.status),
    locked,
    match: `${fx.home_name} vs ${fx.away_name}`,
    homeName: fx.home_name,
    awayName: fx.away_name,
    score: fx.goals_home == null || fx.goals_away == null ? null : `${fx.goals_home}-${fx.goals_away}`,
    report: {
      generated: !!latestVersion,
      cacheReady: !!cache,
      versionCount,
      latestVersion: latestVersion?.ver ?? null,
      generatedAt: latest?.gen_at ?? null,
      model: latest?.model ?? "",
      tokens: latest?.tokens ?? 0,
      changed: latestVersion ? JSON.parse(latestVersion.changed || "[]") as string[] : [],
      summary: reportSummary(latest?.content),
      algorithmVersion: REPORT_FACTS_VERSION,
    },
    access: { free, unlocks, lockedForUsers: !free && unlocks === 0 },
    sources,
    missingInputs,
    failureReason: severe ? `${severe.source}/${severe.endpoint}: ${severe.error_reason}` : "",
    issues,
    canRegenerate: !locked,
  };
}

export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const pastDays = Math.max(1, Math.min(30, Number(req.nextUrl.searchParams.get("pastDays")) || 7));
  const futureDays = Math.max(1, Math.min(45, Number(req.nextUrl.searchParams.get("futureDays")) || 14));
  const now = Date.now();
  const rows = fixturesBetween(now - pastDays * 86_400_000, now + futureDays * 86_400_000).map(reportRow);
  const summary = {
    total: rows.length,
    generated: rows.filter((r) => r.report.generated).length,
    cacheReady: rows.filter((r) => r.report.cacheReady).length,
    missing: rows.filter((r) => !r.report.generated && !r.report.cacheReady).length,
    locked: rows.filter((r) => r.locked).length,
    needsInput: rows.filter((r) => r.missingInputs.length > 0).length,
    failed: rows.filter((r) => r.failureReason).length,
  };
  return NextResponse.json({ ok: true, range: { pastDays, futureDays }, summary, rows });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ ok: false }, { status: 401 });
  if (!canWrite(admin, "*") && admin.role !== "超级管理员" && admin.role !== "运营")
    return NextResponse.json({ ok: false, error: "无权限" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { fixtureId?: number; action?: string };
  const fixtureId = Number(body.fixtureId);
  if (!fixtureId) return NextResponse.json({ ok: false, error: "缺少比赛 id" }, { status: 400 });
  const fx = fixtureById(fixtureId);
  if (!fx) return NextResponse.json({ ok: false, error: "比赛不存在" }, { status: 404 });
  if (body.action === "refresh") return NextResponse.json({ ok: true, row: reportRow(fx) });
  if (body.action !== "regenerate") return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  if (reportLocked(fx.status)) return NextResponse.json({ ok: false, error: "比赛已开赛或完场,报告已锁定,不能重新生成" }, { status: 409 });

  const p = await matchPanorama(fixtureId, { deep: true, injuries: true, preKickoffOnly: true });
  if (!p) return NextResponse.json({ ok: false, error: "比赛数据未就绪" }, { status: 404 });
  const ps = buildReportSummary(p);
  const market = await findPolymarketSignal(p.fixture.home_name, p.fixture.away_name, { fixtureId, kickoffAt: p.fixture.kickoff_utc });
  const signals = buildReportSignals(ps, p.odds, market, p);
  const built = buildReport(p, signals);
  const llm = await getLlmReport(p, built.secs).catch(() => null);
  audit(admin.email, "分析报告重新生成", `${fixtureId} ${p.fixture.home_name} vs ${p.fixture.away_name} ${llm ? "生成新版" : "模板回落/未生成新版本"}`);
  const next = fixtureById(fixtureId) ?? fx;
  return NextResponse.json({ ok: true, generated: !!llm, message: llm ? "已生成新版报告" : "未生成新 LLM 版本,用户端将继续使用模板或缓存", row: reportRow(next) });
}
