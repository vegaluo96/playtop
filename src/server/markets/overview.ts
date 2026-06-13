/**
 * ZSKY 标准盘口总览。
 * 页面只能消费这里输出的核心三盘结果,不要直接从 AF raw 或 odds_snapshots 自己挑主盘。
 */
import {
  mainOddsDecision,
  mainOddsDecisionBefore,
  oddsBundle,
  oddsBundleBefore,
  type MainOddsDecision,
  type OddsBundle,
  type OddsMarket,
  type SnapRow,
} from "../af/store";

export interface MarketOverviewMarket {
  market: OddsMarket;
  series: SnapRow[];
  source: SnapRow | null;
  qualityScore: number;
  books: number;
  selectedBooks: number;
  reason: string;
  warnings: string[];
}

export interface MarketOverview {
  fixtureId: number;
  phase: "PRE_MATCH";
  cutoffAt: number | null;
  odds: OddsBundle;
  markets: Record<OddsMarket, MarketOverviewMarket>;
  dataQualityScore: number;
  lastUpdated: number | null;
  selectedReasons: Record<OddsMarket, string>;
  diagnosticWarnings: string[];
}

export interface PublicMarketOverview {
  fixtureId: number;
  phase: MarketOverview["phase"];
  cutoffAt: number | null;
  dataQualityScore: number;
  lastUpdated: number | null;
  markets: Record<OddsMarket, {
    qualityScore: number;
    books: number;
    selectedBooks: number;
    reason: string;
    warnings: string[];
  }>;
  selectedReasons: Record<OddsMarket, string>;
  diagnosticWarnings: string[];
}

function publicMarketReason(market: MarketOverviewMarket): string {
  const source = market.source;
  if (!source) return market.reason;
  const line = source.line == null ? "无盘口线" : source.line;
  return `共识线 ${line}:覆盖 ${market.selectedBooks}/${market.books} 家,质量 ${market.qualityScore}`;
}

export function publicMarketOverview(overview: MarketOverview | undefined | null): PublicMarketOverview | null {
  if (!overview) return null;
  return {
    fixtureId: overview.fixtureId,
    phase: overview.phase,
    cutoffAt: overview.cutoffAt,
    dataQualityScore: overview.dataQualityScore,
    lastUpdated: overview.lastUpdated,
    markets: {
      ah: {
        qualityScore: overview.markets.ah.qualityScore,
        books: overview.markets.ah.books,
        selectedBooks: overview.markets.ah.selectedBooks,
        reason: publicMarketReason(overview.markets.ah),
        warnings: overview.markets.ah.warnings,
      },
      ou: {
        qualityScore: overview.markets.ou.qualityScore,
        books: overview.markets.ou.books,
        selectedBooks: overview.markets.ou.selectedBooks,
        reason: publicMarketReason(overview.markets.ou),
        warnings: overview.markets.ou.warnings,
      },
      eu: {
        qualityScore: overview.markets.eu.qualityScore,
        books: overview.markets.eu.books,
        selectedBooks: overview.markets.eu.selectedBooks,
        reason: `胜平负完整报价 ${overview.markets.eu.selectedBooks}/${overview.markets.eu.books} 家,质量 ${overview.markets.eu.qualityScore}`,
        warnings: overview.markets.eu.warnings,
      },
    },
    selectedReasons: {
      ah: publicMarketReason(overview.markets.ah),
      ou: publicMarketReason(overview.markets.ou),
      eu: `胜平负完整报价 ${overview.markets.eu.selectedBooks}/${overview.markets.eu.books} 家`,
    },
    diagnosticWarnings: overview.diagnosticWarnings,
  };
}

function marketFromDecision(decision: MainOddsDecision, series: SnapRow[]): MarketOverviewMarket {
  return {
    market: decision.market,
    series,
    source: series.at(-1) ?? decision.source,
    qualityScore: series.length > 0 ? decision.qualityScore : 0,
    books: decision.books,
    selectedBooks: decision.selectedBooks,
    reason: decision.reason,
    warnings: series.length > 0 ? decision.warnings : [...decision.warnings, "未达到用户端展示门禁"],
  };
}

function minVisibleScore(markets: MarketOverviewMarket[]): number {
  const visible = markets.filter((m) => m.series.length > 0);
  return visible.length > 0 ? Math.min(...visible.map((m) => m.qualityScore)) : 0;
}

export function marketOverview(fixtureId: number, opts: { cutoffAt?: number | null } = {}): MarketOverview {
  const cutoffAt = opts.cutoffAt ?? null;
  const odds = cutoffAt == null ? oddsBundle(fixtureId) : oddsBundleBefore(fixtureId, cutoffAt);
  const decisions: Record<OddsMarket, MainOddsDecision> = {
    ah: cutoffAt == null ? mainOddsDecision(fixtureId, "ah") : mainOddsDecisionBefore(fixtureId, "ah", cutoffAt),
    ou: cutoffAt == null ? mainOddsDecision(fixtureId, "ou") : mainOddsDecisionBefore(fixtureId, "ou", cutoffAt),
    eu: cutoffAt == null ? mainOddsDecision(fixtureId, "eu") : mainOddsDecisionBefore(fixtureId, "eu", cutoffAt),
  };
  const markets: Record<OddsMarket, MarketOverviewMarket> = {
    ah: marketFromDecision(decisions.ah, odds.ah),
    ou: marketFromDecision(decisions.ou, odds.ou),
    eu: marketFromDecision(decisions.eu, odds.eu),
  };
  const list = [markets.ah, markets.ou, markets.eu];
  const lastUpdated =
    Math.max(...list.flatMap((m) => m.series.map((row) => row.captured_at)), 0) || null;
  return {
    fixtureId,
    phase: "PRE_MATCH",
    cutoffAt,
    odds,
    markets,
    dataQualityScore: minVisibleScore(list),
    lastUpdated,
    selectedReasons: {
      ah: markets.ah.reason,
      ou: markets.ou.reason,
      eu: markets.eu.reason,
    },
    diagnosticWarnings: list.flatMap((m) => m.warnings.map((w) => `${m.market}:${w}`)),
  };
}

export function marketOverviewBatchBefore(fixtureIds: number[], cutoffByFixture: Map<number, number>): Map<number, MarketOverview> {
  const result = new Map<number, MarketOverview>();
  for (const fixtureId of [...new Set(fixtureIds)]) {
    result.set(fixtureId, marketOverview(fixtureId, { cutoffAt: cutoffByFixture.get(fixtureId) ?? null }));
  }
  return result;
}
