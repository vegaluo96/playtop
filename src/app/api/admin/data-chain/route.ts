/** 后台:单场数据链路诊断。只重放本地归档/缓存,不主动回源 AF。 */
import { NextRequest, NextResponse } from "next/server";
import { dig } from "@/lib/dig";
import { db } from "@/server/db";
import { currentAdmin } from "@/server/admin/auth";
import { requireSameOrigin } from "@/server/platform/rate-limit";
import { normalizeLiveOddsItem, normalizeOddsItem, type DiagnosticIssueDraft } from "@/server/af/normalize";
import { ODDS_PARSER_VERSION } from "@/server/af/diagnostics";
import { fixtureById, fixturesBetween, kvGet, latestPredictionBefore } from "@/server/af/store";
import { isFinished, isLive } from "@/server/af/schedule";
import { marketOverview } from "@/server/markets/overview";
import { parseExtraMarkets } from "@/server/af/markets";
import { liveStats, timelineView } from "@/server/views/detail-tech";
import { lineupsView } from "@/server/views/detail-lineups";
import { synthEventsOf } from "@/server/af/events-synth";
import type { Panorama } from "@/server/af/panorama";
import { buildReportSummary } from "@/server/views/report";
import { buildReportSignals } from "@/server/views/report-signals";
import { readCachedPolymarketSignal, writeConfirmedPolymarketSignal } from "@/server/external/polymarket";
import { buildReportSourceCoverage, sourceCoverageNeedsRebuild } from "@/server/views/source-coverage";

type StepStatus = "PASS" | "WARN" | "FAIL" | "OPEN";

interface Evidence {
  k: string;
  v: string | number | null;
}

interface ChainStep {
  key: string;
  title: string;
  status: StepStatus;
  reason: string;
  evidence: Evidence[];
}

interface ChainCheck {
  title: string;
  status: StepStatus;
  reason: string;
  evidence: Evidence[];
}

interface FixturePayload {
  events?: unknown[];
  statistics?: unknown[];
  lineups?: unknown[];
  players?: unknown[];
  [key: string]: unknown;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function step(key: string, title: string, status: StepStatus, reason: string, evidence: Evidence[] = []): ChainStep {
  return { key, title, status, reason, evidence };
}

function check(title: string, status: StepStatus, reason: string, evidence: Evidence[] = []): ChainCheck {
  return { title, status, reason, evidence };
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function fmtAt(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function countRow(sql: string, ...args: (string | number | null)[]): { n: number; m: number | null } {
  const r = db().prepare(sql).get(...args) as { n?: number; m?: number | null } | undefined;
  return { n: Number(r?.n ?? 0), m: r?.m == null ? null : Number(r.m) };
}

function latestRaw(fixtureId: number, endpoint?: string): { payload: unknown | null; at: number | null } {
  const row = endpoint
    ? db()
        .prepare("SELECT payload, fetched_at at FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = ? ORDER BY fetched_at DESC LIMIT 1")
        .get(fixtureId, endpoint)
    : db().prepare("SELECT payload, captured_at at FROM odds_raw WHERE fixture_id = ? ORDER BY captured_at DESC LIMIT 1").get(fixtureId);
  const r = row as { payload: string; at: number } | undefined;
  return { payload: parseJson<unknown | null>(r?.payload, null), at: r?.at ?? null };
}

function scanPrematchBets(raw: unknown) {
  const bms = arr(dig(raw, "bookmakers"));
  const ids: Record<"eu" | "ah" | "ou", Set<string>> = { eu: new Set(), ah: new Set(), ou: new Set() };
  const samples: Record<"eu" | "ah" | "ou", string[]> = { eu: [], ah: [], ou: [] };
  let bets = 0;
  for (const bm of bms) {
    for (const bet of arr(dig(bm, "bets"))) {
      bets++;
      const id = String(dig(bet, "id") ?? "no-id");
      const name = String(dig(bet, "name") ?? "");
      const values = arr(dig(bet, "values")).map((v) => String(dig(v, "value") ?? ""));
      const label = `${id}:${name || "未命名"}`;
      if (values.some((v) => /^(Home|1)$/i.test(v)) && values.some((v) => /^(Draw|X)$/i.test(v)) && values.some((v) => /^(Away|2)$/i.test(v))) {
        ids.eu.add(id);
        if (samples.eu.length < 4) samples.eu.push(label);
      }
      if (values.some((v) => /^Home\s*[+-]?\d/.test(v)) && values.some((v) => /^Away\s*[+-]?\d/.test(v))) {
        ids.ah.add(id);
        if (samples.ah.length < 4) samples.ah.push(label);
      }
      if (values.some((v) => /^Over\s*\d/i.test(v)) && values.some((v) => /^Under\s*\d/i.test(v))) {
        ids.ou.add(id);
        if (samples.ou.length < 4) samples.ou.push(label);
      }
    }
  }
  return {
    bookmakers: bms.length,
    bets,
    ids: { eu: [...ids.eu], ah: [...ids.ah], ou: [...ids.ou] },
    samples,
  };
}

function scanLiveBets(raw: unknown) {
  const odds = arr(dig(raw, "odds"));
  return odds.map((o) => ({
    id: Number(dig(o, "id")) || null,
    name: String(dig(o, "name") ?? ""),
    values: arr(dig(o, "values")).length,
  }));
}

function snapshotCounts(fixtureId: number) {
  const rows = db()
    .prepare(
      `SELECT market, COUNT(*) n, COUNT(DISTINCT bookmaker_id) books, MAX(captured_at) m
       FROM odds_snapshots WHERE fixture_id = ? GROUP BY market`,
    )
    .all(fixtureId) as { market: string; n: number; books: number; m: number }[];
  const out: Record<string, { n: number; books: number; m: number | null }> = {};
  for (const r of rows) out[r.market] = { n: r.n, books: r.books, m: r.m };
  return out;
}

function liveSnapshotCounts(fixtureId: number) {
  const rows = db()
    .prepare(
      `SELECT market, COUNT(*) n, MAX(captured_at) m
       FROM live_odds_snapshots WHERE fixture_id = ? GROUP BY market`,
    )
    .all(fixtureId) as { market: string; n: number; m: number }[];
  const out: Record<string, { n: number; m: number | null }> = {};
  for (const r of rows) out[r.market] = { n: r.n, m: r.m };
  return out;
}

function marketMeta(market: ReturnType<typeof marketOverview>["markets"]["ah"]) {
  return {
    reason: market.reason,
    line: market.source?.line ?? null,
    books: market.books,
    selectedBooks: market.selectedBooks,
    qualityScore: market.qualityScore,
    seriesLen: market.series.length,
    warnings: market.warnings,
  };
}

function candidates() {
  const now = Date.now();
  return fixturesBetween(now - 3 * 86_400_000, now + 14 * 86_400_000)
    .slice(0, 160)
    .map((f) => ({
      fixtureId: f.fixture_id,
      match: `${f.home_name} vs ${f.away_name}`,
      league: f.league_name,
      kickoffUtc: f.kickoff_utc,
      status: f.status,
      score: f.goals_home == null || f.goals_away == null ? null : `${f.goals_home}-${f.goals_away}`,
    }));
}

function buildDiagnostic(fixtureId: number) {
  const fx = fixtureById(fixtureId);
  if (!fx) return null;
  const now = Date.now();
  const started = isLive(fx.status) || isFinished(fx.status) || now >= fx.kickoff_utc;
  const payload = parseJson<FixturePayload>(fx.payload, {});
  const cutoffAt = Math.min(now, fx.kickoff_utc - 1);

  const rawOdds = latestRaw(fixtureId);
  const rawOddsAf = latestRaw(fixtureId, "odds");
  const rawLiveAf = latestRaw(fixtureId, "odds.live");
  const liveBox = parseJson<{ at?: number; data?: unknown } | null>(kvGet(`fx:${fixtureId}:liveodds`), null);
  const prematchScan = rawOdds.payload ? scanPrematchBets(rawOdds.payload) : null;
  const parserIssues: DiagnosticIssueDraft[] = [];
  const normalized = rawOdds.payload ? normalizeOddsItem(rawOdds.payload, { fixtureId, onIssue: (issue) => parserIssues.push(issue) }) : [];
  const normalizedCounts = normalized.reduce<Record<string, number>>((acc, bm) => {
    for (const mk of bm.markets) acc[mk.market] = (acc[mk.market] ?? 0) + 1;
    return acc;
  }, {});
  const parserSamples = normalized.slice(0, 4).flatMap((bm) =>
    bm.markets.slice(0, 3).map((mk) => `${bm.bookmaker} ${mk.market} line=${mk.line ?? "—"} h=${mk.h} a=${mk.a}${mk.d == null ? "" : ` d=${mk.d}`}`),
  );

  const liveIssues: DiagnosticIssueDraft[] = [];
  const liveFrames = liveBox?.data ? normalizeLiveOddsItem(liveBox.data, { fixtureId, onIssue: (issue) => liveIssues.push(issue) }) : [];
  const liveBets = liveBox?.data ? scanLiveBets(liveBox.data) : [];
  const snaps = snapshotCounts(fixtureId);
  const liveSnaps = liveSnapshotCounts(fixtureId);
  const overview = marketOverview(fixtureId);
  const reportOverview = marketOverview(fixtureId, { cutoffAt });
  const extraMarkets = rawOdds.payload ? parseExtraMarkets(rawOdds.payload) : [];
  const details = {
    events: arr(payload.events).length,
    statistics: arr(payload.statistics).length,
    lineups: arr(payload.lineups).length,
    players: arr(payload.players).length,
  };
  const statsView = liveStats(payload, fx.home_id);
  const timeline = started ? timelineView(payload, fx, synthEventsOf(fixtureId)) : null;
  const lineups = lineupsView(payload, fx.home_id, fx.home_name, fx.away_name);
  const prediction = latestPredictionBefore(fixtureId, cutoffAt);
  const predCount = countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM predictions_snapshots WHERE fixture_id = ?", fixtureId);
  const reportVersions = countRow("SELECT COUNT(*) n, MAX(gen_at) m FROM report_versions WHERE fixture_id = ?", fixtureId);
  const reportCache = countRow("SELECT COUNT(*) n, MAX(gen_at) m FROM report_cache WHERE fixture_id = ?", fixtureId);
  const injuriesBox = parseJson<{ at?: number; data?: unknown[] } | null>(kvGet(`fx:${fixtureId}:injuries`), null);
  const localPanorama: Panorama = {
    fixture: fx,
    bundle: payload as Record<string, unknown>,
    odds: reportOverview.odds,
    marketOverview: reportOverview,
    movements: [],
    prediction: prediction as Record<string, unknown> | null,
    injuries: Array.isArray(injuriesBox?.data) ? injuriesBox.data : [],
    deep: null,
  };
  const localPs = buildReportSummary(localPanorama);
  const cachedMarket = readCachedPolymarketSignal(fx.home_name, fx.away_name, fx.fixture_id) ?? { status: "skipped" as const, note: "尚未请求 Polymarket 缓存" };
  const localSignals = buildReportSignals(localPs, localPanorama.odds, cachedMarket, localPanorama);
  const reportGeneratedAt = reportVersions.m ?? reportCache.m ?? null;
  const sourceCoverage = buildReportSourceCoverage(localPanorama, localSignals, { reportGeneratedAt });
  const diagnostics = db()
    .prepare(
      `SELECT source, endpoint, error_type, error_reason, severity, created_at
       FROM diagnostic_issues WHERE fixture_id = ? ORDER BY created_at DESC LIMIT 12`,
    )
    .all(fixtureId) as { source: string; endpoint: string; error_type: string; error_reason: string; severity: string; created_at: number }[];

  const postKickoffPrematch = countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM odds_snapshots WHERE fixture_id = ? AND captured_at >= ?", fixtureId, fx.kickoff_utc);
  const hasPrematchDisplay = overview.markets.ah.series.length + overview.markets.ou.series.length + overview.markets.eu.series.length > 0;
  const hiddenBreaks: string[] = [];
  if ((normalizedCounts.ah ?? 0) > 0 && overview.markets.ah.series.length === 0) hiddenBreaks.push("raw 已解析出亚盘,但主盘口质量门禁后用户端不展示");
  if ((normalizedCounts.ou ?? 0) > 0 && overview.markets.ou.series.length === 0) hiddenBreaks.push("raw 已解析出大小球,但主盘口质量门禁后用户端不展示");
  if ((normalizedCounts.eu ?? 0) > 0 && overview.markets.eu.series.length === 0) hiddenBreaks.push("raw 已解析出胜平负,但主盘口质量门禁后用户端不展示");
  if (details.statistics > 0 && (!statsView || statsView.length === 0)) hiddenBreaks.push("AF statistics 已入 payload,但统计视图映射后为空");
  if (details.lineups > 0 && !lineups.ready) hiddenBreaks.push("AF lineups 已入 payload,但阵容视图无法匹配主客队");
  if (details.events > 0 && timeline && timeline.rows.length === 0) hiddenBreaks.push("AF events 已入 payload,但赛况时间轴为空");

  const dangerous: string[] = [];
  if (overview.markets.ah.series.length > 0 && !snaps.ah) dangerous.push("用户端亚盘有展示,但 odds_snapshots 未找到来源");
  if (overview.markets.ou.series.length > 0 && !snaps.ou) dangerous.push("用户端大小球有展示,但 odds_snapshots 未找到来源");
  if (overview.markets.eu.series.length > 0 && !snaps.eu) dangerous.push("用户端胜平负有展示,但 odds_snapshots 未找到来源");
  if (statsView && statsView.length > 0 && details.statistics === 0) dangerous.push("用户端技术统计有展示,但 payload.statistics 为空");
  if (lineups.ready && details.lineups === 0) dangerous.push("用户端阵容有展示,但 payload.lineups 为空");
  if ((reportVersions.n > 0 || reportCache.n > 0) && predCount.n === 0 && reportOverview.dataQualityScore === 0)
    dangerous.push("报告已存在,但未找到预测快照和赛前主盘口输入");

  const rawCounts = {
    fixtures: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'fixtures'", fixtureId),
    odds: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'odds'", fixtureId),
    liveOdds: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'odds.live'", fixtureId),
    events: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'fixtures.events'", fixtureId),
    stats: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'fixtures.statistics'", fixtureId),
    lineups: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'fixtures.lineups'", fixtureId),
    players: countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'fixtures.players'", fixtureId),
  };

  const steps: ChainStep[] = [
    step(
      "af-fetch",
      "AF 抓取",
      fx.updated_at ? "PASS" : "OPEN",
      fx.updated_at ? "fixtures_cache 已有本场基础数据;详情端点按窗口补齐" : "本场基础数据未入缓存",
      [
        { k: "fixtures_cache.updated", v: fmtAt(fx.updated_at) },
        { k: "AF raw fixtures", v: rawCounts.fixtures.n },
        { k: "AF raw odds", v: rawCounts.odds.n },
        { k: "AF raw live", v: rawCounts.liveOdds.n },
      ],
    ),
    step(
      "raw-store",
      "raw 入库",
      rawOdds.payload || rawLiveAf.payload || liveBox?.data ? "PASS" : "OPEN",
      rawOdds.payload ? "赛前 odds raw 与 af_raw_payloads 已归档" : liveBox?.data ? "本场只有滚球 raw 缓存/归档" : "暂无赔率 raw,可能未进入赔率窗口或源端暂无赔率",
      [
        { k: "odds_raw", v: countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM odds_raw WHERE fixture_id = ?", fixtureId).n },
        { k: "latest odds_raw", v: fmtAt(rawOdds.at) },
        { k: "latest odds.live raw", v: fmtAt(rawLiveAf.at ?? liveBox?.at ?? null) },
      ],
    ),
    step(
      "parser",
      "parser 解析",
      rawOdds.payload ? (normalized.length > 0 ? (parserIssues.some((i) => i.severity === "error") ? "WARN" : "PASS") : "FAIL") : "OPEN",
      rawOdds.payload ? (normalized.length > 0 ? `解析出 ${normalized.length} 家书商/${Object.values(normalizedCounts).reduce((a, b) => a + b, 0)} 条标准盘口` : "存在 raw 但 parser 没有产出标准盘口") : "无赛前 raw 可重放",
      [
        { k: "parser", v: ODDS_PARSER_VERSION },
        { k: "AH", v: normalizedCounts.ah ?? 0 },
        { k: "OU", v: normalizedCounts.ou ?? 0 },
        { k: "EU", v: normalizedCounts.eu ?? 0 },
        { k: "parser issues", v: parserIssues.length },
      ],
    ),
    step(
      "structure",
      "盘口结构化",
      Object.keys(snaps).length > 0 ? "PASS" : normalized.length > 0 ? "FAIL" : "OPEN",
      Object.keys(snaps).length > 0 ? "odds_snapshots 已有标准化盘口帧" : normalized.length > 0 ? "parser 有产出,但 odds_snapshots 无落库" : "暂无标准化盘口快照",
      [
        { k: "AH snapshots", v: snaps.ah?.n ?? 0 },
        { k: "OU snapshots", v: snaps.ou?.n ?? 0 },
        { k: "EU snapshots", v: snaps.eu?.n ?? 0 },
        { k: "Live snapshots", v: Object.values(liveSnaps).reduce((n, r) => n + r.n, 0) },
      ],
    ),
    step(
      "main-market",
      "主盘口选择",
      hasPrematchDisplay ? (overview.diagnosticWarnings.length > 0 ? "WARN" : "PASS") : Object.keys(snaps).length > 0 ? "WARN" : "OPEN",
      hasPrematchDisplay ? "主盘口来自 MarketOverview 共识线选择,不是 AF 第一条" : "暂无达到展示门禁的主盘口",
      [
        { k: "dataQuality", v: overview.dataQualityScore },
        { k: "AH reason", v: overview.markets.ah.reason },
        { k: "OU reason", v: overview.markets.ou.reason },
        { k: "EU reason", v: overview.markets.eu.reason },
      ],
    ),
    step(
      "view-merge",
      "视图合并",
      hiddenBreaks.length > 0 ? "WARN" : "PASS",
      hiddenBreaks.length > 0 ? hiddenBreaks[0] : "视图层从标准快照和 fixture payload 合并,未发现已入库但映射为空的断点",
      [
        { k: "stats rows", v: statsView?.length ?? 0 },
        { k: "timeline rows", v: timeline?.rows.length ?? 0 },
        { k: "lineups ready", v: lineups.ready ? "yes" : "no" },
        { k: "extra markets", v: extraMarkets.length },
      ],
    ),
    step(
      "user-display",
      "用户端展示",
      dangerous.length > 0 ? "FAIL" : hiddenBreaks.length > 0 ? "WARN" : "PASS",
      dangerous[0] ?? hiddenBreaks[0] ?? "用户端展示项均能追溯到标准快照或 fixture payload",
      [
        { k: "危险模块", v: dangerous.length },
        { k: "有数据未展示", v: hiddenBreaks.length },
        { k: "liveOdds frames", v: liveFrames.length },
      ],
    ),
    step(
      "report-reference",
      "报告引用",
      reportVersions.n > 0 || reportCache.n > 0 ? (dangerous.length > 0 ? "WARN" : "PASS") : predCount.n > 0 || reportOverview.dataQualityScore > 0 ? "OPEN" : "WARN",
      reportVersions.n > 0 ? "报告已有版本历史;引用赛前 cutoff 前的预测和盘口" : reportCache.n > 0 ? "报告缓存存在但尚无版本历史" : "报告未生成或仅可模板回落",
      [
        { k: "predictions", v: predCount.n },
        { k: "latest prediction", v: fmtAt(predCount.m) },
        { k: "report versions", v: reportVersions.n },
        { k: "report cache", v: reportCache.n },
        { k: "report cutoff quality", v: reportOverview.dataQualityScore },
      ],
    ),
  ];

  const checks: ChainCheck[] = [
    check(
      "prematch odds 和 live odds 是否混用",
      postKickoffPrematch.n > 0 ? "FAIL" : "PASS",
      postKickoffPrematch.n > 0 ? "发现开赛后仍写入赛前 odds_snapshots,可能污染即时/报告口径" : "赛前快照与滚球快照分表存储;未发现开赛后赛前快照",
      [
        { k: "post-kickoff prematch snapshots", v: postKickoffPrematch.n },
        { k: "live snapshots", v: Object.values(liveSnaps).reduce((n, r) => n + r.n, 0) },
      ],
    ),
    check(
      "bet id 是否识别正确",
      rawOdds.payload
        ? normalized.length > 0
          ? ((prematchScan?.ids.ah.length ?? 0) + (prematchScan?.ids.ou.length ?? 0) + (prematchScan?.ids.eu.length ?? 0) > 0 ? "PASS" : "WARN")
          : "FAIL"
        : "OPEN",
      rawOdds.payload ? "按 id/name 双保险识别;详情见候选 bet id" : "无赛前 raw,无法复核 bet id",
      [
        { k: "EU ids", v: prematchScan?.ids.eu.join(", ") || "—" },
        { k: "AH ids", v: prematchScan?.ids.ah.join(", ") || "—" },
        { k: "OU ids", v: prematchScan?.ids.ou.join(", ") || "—" },
      ],
    ),
    check(
      "Home/Away/Over/Under 是否正确拆 side + line",
      parserIssues.some((i) => i.errorType === "VALUE_PARSE_FAILED" || i.errorType === "LINE_INVALID") ? "WARN" : normalized.length > 0 ? "PASS" : "OPEN",
      parserIssues.some((i) => i.errorType === "VALUE_PARSE_FAILED" || i.errorType === "LINE_INVALID") ? "部分 value 或 line 无法解析,已记录 issue" : normalized.length > 0 ? "标准盘口已拆成 side + line 并通过水位/满水率检查" : "暂无可检查盘口",
      [
        { k: "samples", v: parserSamples.slice(0, 3).join(" | ") || "—" },
        { k: "parse issues", v: parserIssues.length },
      ],
    ),
    check(
      "主盘口为什么被选中",
      hasPrematchDisplay ? "PASS" : "OPEN",
      hasPrematchDisplay ? "按同线覆盖、主流书商、质量分、平衡水位选择共识线" : "暂无主盘口展示",
      [
        { k: "AH", v: overview.markets.ah.reason },
        { k: "OU", v: overview.markets.ou.reason },
        { k: "EU", v: overview.markets.eu.reason },
      ],
    ),
    check(
      "AF 有数据但用户端没展示",
      hiddenBreaks.length > 0 ? "WARN" : "PASS",
      hiddenBreaks.length > 0 ? hiddenBreaks.join("；") : "未发现已入库数据在视图层断开",
      [{ k: "断点数", v: hiddenBreaks.length }],
    ),
    check(
      "用户端展示但没有真实来源",
      dangerous.length > 0 ? "FAIL" : "PASS",
      dangerous.length > 0 ? dangerous.join("；") : "未发现展示项缺少标准快照或 payload 来源",
      [{ k: "危险模块", v: dangerous.length }],
    ),
  ];

  const diagIssues = diagnostics.map((d) => ({
    status: d.severity === "error" ? "FAIL" : d.severity === "warn" ? "WARN" : "OPEN",
    text: `${d.source}/${d.endpoint}/${d.error_type}: ${d.error_reason}`,
    at: d.created_at,
  }));

  return {
    fixture: {
      fixtureId: fx.fixture_id,
      match: `${fx.home_name} vs ${fx.away_name}`,
      league: fx.league_name,
      round: fx.round,
      kickoffUtc: fx.kickoff_utc,
      status: fx.status,
      score: fx.goals_home == null || fx.goals_away == null ? null : `${fx.goals_home}-${fx.goals_away}`,
    },
    steps,
    checks,
    hiddenBreaks,
    dangerous,
    raw: {
      counts: rawCounts,
      prematch: {
        at: rawOdds.at,
        afRawAt: rawOddsAf.at,
        scan: prematchScan,
        parserIssues: parserIssues.slice(0, 12),
        samples: parserSamples.slice(0, 12),
      },
      live: {
        at: rawLiveAf.at ?? liveBox?.at ?? null,
        bets: liveBets.slice(0, 8),
        frames: liveFrames,
        parserIssues: liveIssues.slice(0, 8),
      },
    },
    storage: { snapshots: snaps, liveSnapshots: liveSnaps, details },
    main: {
      selectedReasons: Object.entries(overview.selectedReasons).map(([k, v]) => `${k.toUpperCase()}: ${v}`),
      warnings: overview.diagnosticWarnings,
      markets: {
        ah: marketMeta(overview.markets.ah),
        ou: marketMeta(overview.markets.ou),
        eu: marketMeta(overview.markets.eu),
      },
    },
    view: {
      statsRows: statsView?.length ?? 0,
      timelineRows: timeline?.rows.length ?? 0,
      lineupsReady: lineups.ready,
      extraMarkets: extraMarkets.map((m) => m.name),
      predictionReady: !!prediction,
    },
    report: {
      predictions: predCount,
      versions: reportVersions,
      cache: reportCache,
      cutoffAt,
      cutoffQuality: reportOverview.dataQualityScore,
      sourceCoverage,
      needsRebuild: sourceCoverageNeedsRebuild(sourceCoverage),
    },
    diagnostics: diagIssues,
  };
}

export async function GET(req: NextRequest) {
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const fixtureId = Number(req.nextUrl.searchParams.get("fixtureId") || 0);
  if (!fixtureId) return NextResponse.json({ ok: true, candidates: candidates(), diag: null });
  const diag = buildDiagnostic(fixtureId);
  if (!diag) return NextResponse.json({ ok: false, error: "比赛不存在", candidates: candidates() }, { status: 404 });
  return NextResponse.json({ ok: true, candidates: candidates(), diag });
}

export async function POST(req: NextRequest) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;
  if (!(await currentAdmin())) return NextResponse.json({ ok: false }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { fixtureId?: number; action?: string };
  const fixtureId = Number(body.fixtureId);
  if (!fixtureId) return NextResponse.json({ ok: false, error: "缺少比赛 id" }, { status: 400 });
  const fx = fixtureById(fixtureId);
  if (!fx) return NextResponse.json({ ok: false, error: "比赛不存在" }, { status: 404 });
  if (body.action !== "confirmPolymarket") return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  const cached = readCachedPolymarketSignal(fx.home_name, fx.away_name, fixtureId);
  if (!cached) return NextResponse.json({ ok: false, error: "暂无 Polymarket 候选缓存" }, { status: 404 });
  if (cached.status !== "pendingReview" || !cached.selectedMarket)
    return NextResponse.json({ ok: false, error: "当前没有待确认候选市场" }, { status: 409 });
  writeConfirmedPolymarketSignal(fx.home_name, fx.away_name, fixtureId, cached);
  return NextResponse.json({ ok: true, message: "已确认 Polymarket 候选市场", diag: buildDiagnostic(fixtureId) });
}
