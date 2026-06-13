import { db } from "../db";
import type { Panorama } from "../af/panorama";
import { kvGet } from "../af/store";
import { readCachedPolymarketSignal } from "../external/polymarket";
import { hasUsableProbability, type ReportSignals } from "./report-signals";
import { buildReportSummary } from "./report";

export type SourceCoverageKey =
  | "afPredictions"
  | "polymarket"
  | "prematchOdds"
  | "liveOdds"
  | "lineups"
  | "injuries"
  | "standings"
  | "recentForm"
  | "statistics"
  | "events"
  | "weather";

export type SourceCoverageStatus = "used" | "missing" | "failed" | "stale" | "pendingReview";

export interface SourceCoverageItem {
  key: SourceCoverageKey;
  label: string;
  status: SourceCoverageStatus;
  lastFetchedAt: number | null;
  dataVersion: string;
  missingReason?: string;
  failReason?: string;
  confidence: number;
  usedInReport: boolean;
  detail?: Record<string, unknown>;
}

export type SourceCoverage = Record<SourceCoverageKey, SourceCoverageItem>;

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function countRow(sql: string, ...args: (string | number | null)[]): { n: number; m: number | null } {
  const r = db().prepare(sql).get(...args) as { n?: number; m?: number | null } | undefined;
  return { n: Number(r?.n ?? 0), m: r?.m == null ? null : Number(r.m) };
}

function latestIssue(fixtureId: number, clauses: string, ...args: string[]) {
  return db()
    .prepare(
      `SELECT source, endpoint, error_type, error_reason, severity, created_at
       FROM diagnostic_issues
       WHERE fixture_id = ? AND ${clauses}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(fixtureId, ...args) as
    | { source: string; endpoint: string; error_type: string; error_reason: string; severity: string; created_at: number }
    | undefined;
}

function kvBoxAt(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const box = JSON.parse(raw) as { at?: number };
    return box.at == null ? null : Number(box.at) || null;
  } catch {
    return null;
  }
}

function item(input: SourceCoverageItem): SourceCoverageItem {
  return input;
}

function maybeStale(input: SourceCoverageItem, reportGeneratedAt?: number | null): SourceCoverageItem {
  if (!reportGeneratedAt || !input.lastFetchedAt) return input;
  if (input.status === "failed" || input.status === "missing") return input;
  if (input.lastFetchedAt <= reportGeneratedAt + 60_000) return input;
  return {
    ...input,
    status: "stale",
    failReason: undefined,
    missingReason: undefined,
    detail: {
      ...(input.detail ?? {}),
      staleReason: "报告生成后该来源出现新快照,需要重新生成或等待自动版本更新",
      reportGeneratedAt,
    },
  };
}

function lineupsCoverage(p: Panorama): SourceCoverageItem {
  const rows = arr(dig(p.bundle, "lineups"));
  return item({
    key: "lineups",
    label: "阵容/首发",
    status: rows.length > 0 ? "used" : "missing",
    lastFetchedAt: rows.length > 0 ? p.fixture.updated_at : null,
    dataVersion: `payload:${p.fixture.updated_at || 0}:lineups:${rows.length}`,
    missingReason: rows.length > 0 ? undefined : "暂未公布或尚未进入临场抓取窗口",
    confidence: rows.length > 0 ? 88 : 0,
    usedInReport: false,
    detail: { rows: rows.length, reportUse: "当前报告仅追踪阵容可用性,未把阵型差异直接量化为分值" },
  });
}

function weatherCoverage(p: Panorama): SourceCoverageItem {
  const city = String(dig(p.bundle, "fixture", "venue", "city") ?? "");
  const issue = latestIssue(p.fixture.fixture_id, "source = 'WEATHER'");
  const at = issue?.created_at ?? null;
  return item({
    key: "weather",
    label: "天气",
    status: issue?.severity === "error" ? "failed" : "missing",
    lastFetchedAt: at,
    dataVersion: `weather:${at ?? 0}`,
    missingReason: issue ? issue.error_reason : "天气为按需增强源,本场尚无可用天气快照",
    failReason: issue?.severity === "error" ? issue.error_reason : undefined,
    confidence: 0,
    usedInReport: false,
    detail: { city, issue: issue ? { type: issue.error_type, endpoint: issue.endpoint } : null },
  });
}

export function buildReportSourceCoverage(
  p: Panorama,
  signals: ReportSignals,
  opts: { reportGeneratedAt?: number | null } = {},
): SourceCoverage {
  const fixtureId = p.fixture.fixture_id;
  const generatedAt = opts.reportGeneratedAt ?? null;
  const ps = buildReportSummary(p);
  const predSnap = countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM predictions_snapshots WHERE fixture_id = ?", fixtureId);
  const predRaw = countRow("SELECT COUNT(*) n, MAX(fetched_at) m FROM af_raw_payloads WHERE fixture_id = ? AND endpoint = 'predictions'", fixtureId);
  const predIssue = latestIssue(fixtureId, "endpoint = 'predictions'");
  const rawOdds = countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM odds_raw WHERE fixture_id = ?", fixtureId);
  const prematchSnaps = countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM odds_snapshots WHERE fixture_id = ?", fixtureId);
  const liveSnaps = countRow("SELECT COUNT(*) n, MAX(captured_at) m FROM live_odds_snapshots WHERE fixture_id = ?", fixtureId);
  const events = arr(dig(p.bundle, "events"));
  const statistics = arr(dig(p.bundle, "statistics"));
  const polyCached = readCachedPolymarketSignal(p.fixture.home_name, p.fixture.away_name, fixtureId);
  const poly = signals.market.status === "skipped" ? polyCached : signals.market;
  const injuriesAt = kvBoxAt(kvGet(`fx:${fixtureId}:injuries`));
  const hasOdds = p.odds.ah.length + p.odds.ou.length + p.odds.eu.length > 0;
  const hasDeepStats = !!p.deep?.statsHome && !!p.deep?.statsAway;
  const hasForm = !!ps && (ps.formHome.length > 0 || ps.formAway.length > 0);
  const hasStats = statistics.length > 0;
  const hasEvents = events.length > 0;
  const predStatus: SourceCoverageStatus =
    predIssue?.severity === "error" && !p.prediction
      ? "failed"
      : p.prediction
        ? "used"
        : "missing";
  const polyStatus: SourceCoverageStatus =
    !poly
      ? "missing"
      : poly.status === "ok" && !poly.needsReview
        ? "used"
        : poly.status === "pendingReview"
          ? "pendingReview"
          : poly.status === "error"
            ? "failed"
            : "missing";

  const coverage: SourceCoverage = {
    afPredictions: item({
      key: "afPredictions",
      label: "AF Predictions",
      status: predStatus,
      lastFetchedAt: predSnap.m ?? predRaw.m ?? predIssue?.created_at ?? null,
      dataVersion: `pred:${predSnap.m ?? predRaw.m ?? 0}`,
      missingReason: predStatus === "missing" ? (predIssue?.error_reason ?? "尚无预测快照;可能未到抓取窗口、源端无覆盖或仍在负缓存等待重试") : undefined,
      failReason: predStatus === "failed" ? predIssue?.error_reason : undefined,
      confidence: p.prediction ? (hasUsableProbability(ps) ? 92 : 62) : 0,
      usedInReport: !!p.prediction,
      detail: {
        snapshots: predSnap.n,
        raw: predRaw.n,
        probabilityReady: hasUsableProbability(ps),
        latestIssue: predIssue ? { type: predIssue.error_type, reason: predIssue.error_reason, severity: predIssue.severity } : null,
      },
    }),
    polymarket: item({
      key: "polymarket",
      label: "Polymarket",
      status: polyStatus,
      lastFetchedAt: poly?.capturedAt ?? null,
      dataVersion: `poly:${poly?.capturedAt ?? 0}:${poly?.matchScore ?? 0}`,
      missingReason: polyStatus === "missing" ? (poly?.note ?? "尚未请求或暂无可精确匹配的公开预测市场") : undefined,
      failReason: polyStatus === "failed" ? poly?.note : undefined,
      confidence: polyStatus === "used" ? Math.min(95, Math.max(50, poly?.matchScore ?? 60)) : polyStatus === "pendingReview" ? Math.max(35, poly?.matchScore ?? 48) : 0,
      usedInReport: polyStatus === "used",
      detail: {
        queries: poly?.queries ?? [],
        candidates: poly?.candidates ?? [],
        selectedMarket: poly?.selectedMarket ?? null,
        matchScore: poly?.matchScore ?? null,
        marketType: poly?.marketType ?? null,
        needsReview: !!poly?.needsReview,
      },
    }),
    prematchOdds: item({
      key: "prematchOdds",
      label: "赛前盘口",
      status: hasOdds ? "used" : "missing",
      lastFetchedAt: prematchSnaps.m ?? rawOdds.m,
      dataVersion: `prematch:${p.marketOverview?.lastUpdated ?? prematchSnaps.m ?? 0}:${p.marketOverview?.dataQualityScore ?? 0}`,
      missingReason: hasOdds ? undefined : "暂无达到展示门槛的赛前主盘口",
      confidence: hasOdds ? Math.max(45, p.marketOverview?.dataQualityScore ?? 55) : 0,
      usedInReport: hasOdds,
      detail: {
        rawOdds: rawOdds.n,
        snapshots: prematchSnaps.n,
        ah: p.odds.ah.length,
        ou: p.odds.ou.length,
        eu: p.odds.eu.length,
        qualityScore: p.marketOverview?.dataQualityScore ?? 0,
      },
    }),
    liveOdds: item({
      key: "liveOdds",
      label: "滚球盘口",
      status: liveSnaps.n > 0 ? "used" : "missing",
      lastFetchedAt: liveSnaps.m,
      dataVersion: `live:${liveSnaps.m ?? 0}:${liveSnaps.n}`,
      missingReason: liveSnaps.n > 0 ? undefined : "开赛后更新;未开赛或源端暂无滚球快照",
      confidence: liveSnaps.n > 0 ? 82 : 0,
      usedInReport: false,
      detail: { snapshots: liveSnaps.n, reportUse: "报告按赛前锁定,滚球盘口仅用于赛中展示和异动" },
    }),
    lineups: lineupsCoverage(p),
    injuries: item({
      key: "injuries",
      label: "伤停",
      status: p.injuries.length > 0 ? "used" : "missing",
      lastFetchedAt: injuriesAt,
      dataVersion: `injuries:${injuriesAt ?? 0}:${p.injuries.length}`,
      missingReason: p.injuries.length > 0 ? undefined : "暂无伤停通报或尚未请求到缓存",
      confidence: p.injuries.length > 0 ? 78 : 0,
      usedInReport: p.injuries.length > 0,
      detail: { rows: p.injuries.length },
    }),
    standings: item({
      key: "standings",
      label: "积分/赛季统计",
      status: hasDeepStats ? "used" : "missing",
      lastFetchedAt: null,
      dataVersion: `season:${p.fixture.season}:${hasDeepStats ? 1 : 0}`,
      missingReason: hasDeepStats ? undefined : "赛季统计未加载或源端暂无本赛季面板",
      confidence: hasDeepStats ? 74 : 0,
      usedInReport: hasDeepStats,
      detail: { homeReady: !!p.deep?.statsHome, awayReady: !!p.deep?.statsAway },
    }),
    recentForm: item({
      key: "recentForm",
      label: "近期状态",
      status: hasForm ? "used" : "missing",
      lastFetchedAt: predSnap.m ?? predRaw.m,
      dataVersion: `form:${predSnap.m ?? predRaw.m ?? 0}`,
      missingReason: hasForm ? undefined : "近期战绩通常随预测快照下发;当前样本不足",
      confidence: hasForm ? 70 : 0,
      usedInReport: hasForm,
      detail: { homeForm: ps?.formHome ?? "", awayForm: ps?.formAway ?? "" },
    }),
    statistics: item({
      key: "statistics",
      label: "技术统计",
      status: hasStats ? "used" : "missing",
      lastFetchedAt: hasStats ? p.fixture.updated_at : null,
      dataVersion: `stats:${p.fixture.updated_at || 0}:${statistics.length}`,
      missingReason: hasStats ? undefined : "开赛后更新;赛前不生成技术统计",
      confidence: hasStats ? 86 : 0,
      usedInReport: false,
      detail: { rows: statistics.length },
    }),
    events: item({
      key: "events",
      label: "赛况事件",
      status: hasEvents ? "used" : "missing",
      lastFetchedAt: hasEvents ? p.fixture.updated_at : null,
      dataVersion: `events:${p.fixture.updated_at || 0}:${events.length}`,
      missingReason: hasEvents ? undefined : "开赛后更新;赛前不生成赛况事件",
      confidence: hasEvents ? 86 : 0,
      usedInReport: false,
      detail: { rows: events.length },
    }),
    weather: weatherCoverage(p),
  };

  return Object.fromEntries(
    Object.entries(coverage).map(([k, v]) => [k, maybeStale(v, generatedAt)]),
  ) as SourceCoverage;
}

export function sourceCoverageNeedsRebuild(coverage: SourceCoverage): boolean {
  return Object.values(coverage).some((s) => s.status === "stale");
}
