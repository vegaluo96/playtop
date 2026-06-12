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
