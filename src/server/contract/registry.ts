/**
 * 数据契约 · 机器可读单一真相(配套 docs/data-contract.md)。
 *
 * 目的:让"AF 源是否完整""用户端字段是否对得上"由**机器判定**,不靠人工对比。
 * - `AF_ENDPOINT_ROLE`:catalog 登记的每个 AF 端点的归属。漏接/新增未分类 → 测试 fail。
 * - `USER_ROUTE_CONTRACT`:每个用户端路由允许的响应顶层字段 + 拟合字段 + 锁定差异。
 *   路由实际返回字段超出/缺失登记 → selfcheck 报漂移。
 *
 * 改了任意一端(AF 端点、路由字段),必须同步本文件,否则 `data-contract.test.ts`
 * 或 `selfcheck` 失败。这就是反功能漂移的闸门。
 */
import type { SourceCoverageKey } from "../views/source-coverage";

/** AF 端点归属 */
export type EndpointRole =
  | "user" // 喂某个用户可见面
  | "internal" // 仅后台/监控/调度
  | "dropped"; // 登记但生产不消费(仅 catalog/selftest 可测,或有意舍弃)

export interface EndpointSpec {
  role: EndpointRole;
  /** 该端点喂入的覆盖键(无则 null);外部源(polymarket/weather)不在 AF 端点内 */
  coverage: SourceCoverageKey | null;
  /** 落库表 / kv 前缀(简写) */
  sink: string;
  note: string;
}

/**
 * catalog.ts 登记的 39 个 AF 端点逐一归属。
 * 权威分类对照 docs/history/af-coverage.md(人工维护矩阵)+ 代码实读。
 */
export const AF_ENDPOINT_ROLE: Record<string, EndpointSpec> = {
  status: { role: "internal", coverage: null, sink: "kv:af_status", note: "套餐/配额监控" },
  timezone: { role: "dropped", coverage: null, sink: "-", note: "平台统一 UTC 存储,前端按 tz 换算" },
  countries: { role: "dropped", coverage: null, sink: "-", note: "联赛结果已带 country,无单列场景" },
  venues: { role: "user", coverage: null, sink: "fixtures_cache.payload / kv:venue", note: "详情·球场(容量/草皮)" },
  leagues: { role: "user", coverage: null, sink: "kv:data:*", note: "联赛 chips(经 cfg:leagues)+ 赛季枢纽" },
  "leagues.seasons": { role: "dropped", coverage: null, sink: "-", note: "season 来自 fixtures.league.season" },
  teams: { role: "dropped", coverage: null, sink: "-", note: "队名来自 fixtures,队徽 CDN 按 id;端点仅 selftest" },
  "teams.statistics": { role: "user", coverage: "standings", sink: "kv:team:*:lgstats", note: "详情·赛季面板" },
  "teams.seasons": { role: "dropped", coverage: null, sink: "-", note: "无展示场景" },
  "teams.countries": { role: "dropped", coverage: null, sink: "-", note: "无展示场景" },
  standings: { role: "user", coverage: "standings", sink: "kv:data:*:standings", note: "数据页积分榜 + 详情对比" },
  fixtures: { role: "user", coverage: null, sink: "fixtures_cache", note: "列表/详情头/比分/状态/日期带" },
  "fixtures.rounds": { role: "dropped", coverage: null, sink: "-", note: "轮次来自 fixtures.league.round + roundZh" },
  "fixtures.headtohead": { role: "user", coverage: null, sink: "kv:h2h", note: "详情·历史交锋" },
  "fixtures.statistics": { role: "user", coverage: "statistics", sink: "fixtures_cache.payload + kv:stats_half", note: "详情·技术统计/半场" },
  "fixtures.events": { role: "user", coverage: "events", sink: "fixtures_cache.payload + kv:synthev", note: "详情·赛况时间轴" },
  "fixtures.lineups": { role: "user", coverage: "lineups", sink: "fixtures_cache.payload", note: "详情·首发阵容" },
  "fixtures.players": { role: "user", coverage: null, sink: "fixtures_cache.payload", note: "详情·球员实时评分" },
  injuries: { role: "user", coverage: "injuries", sink: "kv:fx:*:injuries", note: "详情·伤停 + 报告人员小节" },
  predictions: { role: "user", coverage: "afPredictions", sink: "predictions_snapshots + af_raw_payloads", note: "概率/七维/进球模型/近况(recentForm)" },
  sidelined: { role: "user", coverage: null, sink: "kv(player)", note: "球员资料卡·伤停/停赛史" },
  coachs: { role: "user", coverage: null, sink: "kv:team:*:coachs", note: "详情·教练档案" },
  players: { role: "user", coverage: null, sink: "kv(player) / kv:team:*:ratings", note: "球员卡 + 赛季评分" },
  "players.seasons": { role: "user", coverage: null, sink: "kv(player)", note: "球员卡·可用赛季" },
  "players.profiles": { role: "user", coverage: null, sink: "kv(player)", note: "球员卡·基础资料(无统计时兜底)" },
  "players.squads": { role: "user", coverage: null, sink: "kv:team:*:squad", note: "详情·阵容深度" },
  "players.teams": { role: "user", coverage: null, sink: "kv(player)", note: "球员卡·效力球队" },
  "players.topscorers": { role: "user", coverage: "recentForm", sink: "kv:lg:*:topscorers", note: "数据页射手榜 + 深挖" },
  "players.topassists": { role: "user", coverage: "recentForm", sink: "kv:lg:*:topassists", note: "数据页助攻榜 + 深挖" },
  "players.topyellowcards": { role: "user", coverage: null, sink: "kv:lg:*:topyellow", note: "深挖·黄牌榜" },
  "players.topredcards": { role: "user", coverage: null, sink: "kv:lg:*:topred", note: "深挖·红牌榜" },
  transfers: { role: "user", coverage: null, sink: "kv:team:*:transfers", note: "详情·转会动态" },
  trophies: { role: "user", coverage: null, sink: "kv:coach:*:trophies", note: "详情·教练荣誉" },
  odds: { role: "user", coverage: "prematchOdds", sink: "af_raw_payloads + odds_raw + odds_snapshots", note: "赛前主盘/走势/百家/综合指数" },
  "odds.mapping": { role: "dropped", coverage: null, sink: "-", note: "覆盖映射表,监控用不主动消费" },
  "odds.bookmakers": { role: "dropped", coverage: null, sink: "-", note: "书商字典,归一化按 id/name 双保险" },
  "odds.bets": { role: "dropped", coverage: null, sink: "-", note: "玩法字典,未动态拉取" },
  "odds.live": { role: "user", coverage: "liveOdds", sink: "af_raw_payloads + live_odds_snapshots + kv:liveodds", note: "滚球盘/实时跳动/滚球异动" },
  "odds.live.bets": { role: "dropped", coverage: null, sink: "-", note: "滚球玩法字典,只取主盘" },
};

/** AF v3 不存在、不得伪造的源(出现在 coverage 里但非 AF 端点) */
export const NON_AF_SOURCES: { key: SourceCoverageKey; note: string }[] = [
  { key: "weather", note: "AF v3 无天气端点;走 MET Norway + Open-Meteo,拿不到整卡隐藏" },
  { key: "polymarket", note: "外部预测市场 Gamma public-search,非 AF" },
];

/** 拟合值的标准来源标记(对应 §5 字段信封 / DirectionSignal.sourceKind) */
export type FittedSourceKind = "prediction" | "marketDerived" | "marketOnly" | "model" | "mixed" | "open";

export interface RouteContract {
  /** 路由(相对 /api) */
  route: string;
  /** 允许的响应顶层字段(超出/缺失 = 漂移) */
  fields: string[];
  /** 其中属于"拟合/派生值"的字段(必须带就绪/来源标记) */
  fitted: string[];
  /** 锁定(未解锁)时为 null/空的字段 */
  lockedNull: string[];
  /** 该路由消费的视图模型(F3:不得自挑主盘/重算) */
  viewModels: string[];
}

/**
 * 用户端 GET 路由响应契约。字段集来自盘点(见 docs/data-contract.md §12),
 * selfcheck 以此核查实际响应字段 ⊆ fields。POST/账户类路由不在拟合契约内。
 */
export const USER_ROUTE_CONTRACT: RouteContract[] = [
  {
    route: "/matches",
    fields: ["ok", "rows", "liveCount", "loggedIn"],
    fitted: ["rows.ah", "rows.ou", "rows.eu", "rows.ex", "rows.q"],
    lockedNull: ["rows.ah", "rows.ou", "rows.eu", "rows.q"], // masked 时为 null;滚球 q 也为 null
    viewModels: ["marketCell", "liveAwareSeriesBatch", "liveExtras", "mainOddsDecisionBatch"],
  },
  {
    route: "/match/[id]",
    fields: ["ok", "header", "summary", "marketOverview", "liveOdds", "odds", "comp", "tech", "markets", "weather", "insights", "lineups", "intel", "deep", "loggedIn", "unlocked", "price"],
    fitted: ["summary", "marketOverview", "odds.index", "comp.euMeta", "comp.trend", "insights"],
    lockedNull: ["deep"], // deep=1 才有
    viewModels: ["detailView", "publicMarketOverview", "compositePre/Live", "seriesRows", "insightsView"],
  },
  {
    route: "/match/[id]/history",
    fields: ["ok", "n", "src", "startAt", "rows"],
    fitted: [],
    lockedNull: [],
    viewModels: ["quoteHistory"],
  },
  {
    route: "/report/[id]",
    fields: ["ok", "id", "match", "league", "leagueId", "time", "pH", "pD", "pA", "probReady", "comparison", "comparisonReady", "homeName", "awayName", "advice", "summaryReady", "directions", "model", "market", "marketOverview", "sourceCoverage", "sourceCoverageNeedsRebuild", "fittingScope", "sections", "genBy", "versions", "ver", "lockedFinal", "locked", "loggedIn", "price"],
    fitted: ["pH", "pD", "pA", "comparison", "advice", "directions", "model", "market", "marketOverview", "sourceCoverage"],
    lockedNull: ["advice", "directions", "model", "market", "sections", "versions", "ver"], // unlocked 才有;pH/pD/pA 由 probReady 门控
    viewModels: ["buildReportSummary", "buildReportSignals", "publicProbability", "publicComparison", "publicReportAdvice", "publicMarketOverview", "publicSourceCoverage"],
  },
  {
    route: "/predictions",
    fields: ["ok", "cards", "record", "loggedIn"],
    fitted: ["cards.pH", "cards.pD", "cards.pA", "cards.advice", "cards.ahKind", "cards.ouKind", "cards.ahDerived", "cards.ouDerived", "cards.marketOverview", "cards.sourceCoverage"],
    lockedNull: ["cards.advice", "cards.winnerText", "cards.ahText", "cards.uoText", "cards.goalsText", "cards.sourceCoverage"],
    viewModels: ["predSummary", "buildReportSignals", "publicProbability", "publicReportAdvice", "publicMarketOverview", "publicSourceCoverage"],
  },
  {
    route: "/moves",
    fields: ["ok", "rows", "loggedIn"],
    fitted: ["rows.direction", "rows.waterLabel", "rows.note"],
    lockedNull: ["rows.from", "rows.to", "rows.water", "rows.note", "rows.rows"], // masked 时脱敏
    viewModels: ["movements", "detectMovement"],
  },
  {
    route: "/data",
    fields: ["ok", "league", "season", "seasonSource", "standings", "scorers", "assists", "schedule"],
    fitted: [],
    lockedNull: [],
    viewModels: ["dataCenterView"],
  },
  {
    route: "/player/[id]",
    fields: ["ok", "id", "name", "age", "nationality", "height", "weight", "injured", "stats", "seasons", "careerTeams", "sidelined"],
    fitted: [],
    lockedNull: [],
    viewModels: ["playerCard"],
  },
  {
    route: "/config",
    fields: ["ok", "leagues", "announcements", "version", "rechargeMaintenance"],
    fitted: [],
    lockedNull: [],
    viewModels: ["cfgLeagues", "cfgAnnouncements"],
  },
  {
    route: "/health",
    fields: ["ok", "now", "workerAt", "liveNow", "intervals"],
    fitted: [],
    lockedNull: [],
    viewModels: ["cfgTierIntervals"],
  },
];

/** 在契约登记内的用户端 GET 路由 key(供测试核对路由是否漏登记) */
export const CONTRACTED_ROUTES = new Set(USER_ROUTE_CONTRACT.map((r) => r.route));

/**
 * 账户/会话/埋点类路由:不属于"拟合数据契约"(无源拟合),核查时跳过。
 * 列在此处是为了"全部用户端路由都被显式归类",新增路由若两边都没有 → 测试 fail。
 */
export const NON_FITTED_USER_ROUTES = new Set<string>([
  "/me", "/wallet", "/invite", "/tickets", "/track", "/unlock",
  "/auth/login", "/auth/logout",
]);
