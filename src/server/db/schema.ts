import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 全局配置（KV）：apiyi / datasources / engine / pricing */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  updatedAt: integer("updated_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    points: integer("points").notNull().default(0),
    status: text("status", { enum: ["active", "banned"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** 积分流水（append-only，余额变动唯一来源） */
export const pointTransactions = sqliteTable(
  "point_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    type: text("type", {
      enum: ["admin_grant", "admin_deduct", "unlock", "refund"],
    }).notNull(),
    refMatchId: integer("ref_match_id"),
    note: text("note"),
    adminId: integer("admin_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ptx_user_time_idx").on(t.userId, t.createdAt)],
);

export const leagues = sqliteTable(
  "leagues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** football-data.co.uk 联赛代码，如 E0/SP1/I1；手动联赛可空 */
    code: text("code"),
    name: text("name").notNull(),
    country: text("country"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("leagues_code_uq").on(t.code)],
);

export const teams = sqliteTable(
  "teams",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    country: text("country"),
    /** CSV 队名别名（JSON string[]），用于 football-data.co.uk 队名归一 */
    aliases: text("aliases").notNull().default("[]"),
    homeVenue: text("home_venue"),
    venueLat: real("venue_lat"),
    venueLon: real("venue_lon"),
    logoUrl: text("logo_url"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("teams_country_name_uq").on(t.country, t.name)],
);

/** Elo 当前值（历史轨迹随 analyses.engine_output 留痕） */
export const teamRatings = sqliteTable("team_ratings", {
  teamId: integer("team_id")
    .primaryKey()
    .references(() => teams.id),
  elo: real("elo").notNull().default(1500),
  matchesPlayed: integer("matches_played").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/** 模型训练用历史赛果库（football-data.co.uk 导入 + 结算回填），与产品比赛分离 */
export const historyMatches = sqliteTable(
  "history_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id),
    season: text("season"),
    playedAt: integer("played_at").notNull(),
    homeTeamId: integer("home_team_id")
      .notNull()
      .references(() => teams.id),
    awayTeamId: integer("away_team_id")
      .notNull()
      .references(() => teams.id),
    homeGoals: integer("home_goals").notNull(),
    awayGoals: integer("away_goals").notNull(),
    htHome: integer("ht_home"),
    htAway: integer("ht_away"),
    /** 中立场（国际赛事）：DC 拟合时该场不计主场优势 */
    neutral: integer("neutral").notNull().default(0),
    /** 技术统计 JSON：{shots, shotsOnTarget, corners, fouls, yellows, reds…按主客} */
    stats: text("stats"),
    /** 收盘赔率 JSON：{home, draw, away, over25, under25, ahLine, ahHome, ahAway} */
    closingOdds: text("closing_odds"),
    referee: text("referee"),
    /** 防重复导入：league|date|home|away 规范键 */
    dedupKey: text("dedup_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("hm_dedup_uq").on(t.dedupKey),
    index("hm_league_time_idx").on(t.leagueId, t.playedAt),
    index("hm_home_idx").on(t.homeTeamId, t.playedAt),
    index("hm_away_idx").on(t.awayTeamId, t.playedAt),
  ],
);

export const MATCH_STATUSES = [
  "scheduled",
  "collecting",
  "ready",
  "analyzed",
  "published",
  "in_play",
  "finished",
  "settled",
  "void",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const matches = sqliteTable(
  "matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** CSV 导入键：div|date|home|away；手动建赛可空 */
    extId: text("ext_id"),
    leagueId: integer("league_id")
      .notNull()
      .references(() => leagues.id),
    homeTeamId: integer("home_team_id")
      .notNull()
      .references(() => teams.id),
    awayTeamId: integer("away_team_id")
      .notNull()
      .references(() => teams.id),
    kickoffAt: integer("kickoff_at").notNull(),
    venue: text("venue"),
    venueLat: real("venue_lat"),
    venueLon: real("venue_lon"),
    /** 中立场（世界杯等国际大赛）：引擎不计主场优势 */
    neutral: integer("neutral").notNull().default(0),
    round: text("round"),
    source: text("source", { enum: ["csv", "manual", "openfootball"] }).notNull(),
    status: text("status", { enum: MATCH_STATUSES }).notNull().default("scheduled"),
    /** 解锁价格（积分）；发布时定价，解锁按比赛计（覆盖赛前全部实时改版） */
    pricePoints: integer("price_points"),
    /** 开赛锁定的终版研报 id（战绩结算只看终版；不设 FK 以避免环引用） */
    finalAnalysisId: integer("final_analysis_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("matches_ext_uq").on(t.extId),
    index("matches_kickoff_idx").on(t.kickoffAt),
    index("matches_status_idx").on(t.status),
  ],
);

export const SNAPSHOT_KINDS = [
  "odds",
  "injuries",
  "suspensions",
  "lineups",
  "h2h",
  "form",
  "team_stats",
  "standings",
  "player_stats",
  "coach",
  "venue",
  "weather",
  "referee",
  "soft_info",
  "external_ratings",
  "manual_override",
] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** 数据快照：不可变，只插不改不删；引擎取每 kind 最新一行；odds 多行构成盘口异动序列 */
export const dataSnapshots = sqliteTable(
  "data_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id),
    kind: text("kind", { enum: SNAPSHOT_KINDS }).notNull(),
    source: text("source", {
      enum: [
        "football_data_couk",
        "open_meteo",
        "local_stats",
        "llm",
        "manual",
        "sporttery",
        "polymarket",
        "espn",
        "github",
        "clubelo",
        "eloratings",
        "manifold",
        "smarkets",
        "understat",
        "api_football",
      ],
    }).notNull(),
    payload: text("payload").notNull(), // JSON，符合 datasources/types.ts 归一化 schema
    contentHash: text("content_hash").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [index("snap_match_kind_time_idx").on(t.matchId, t.kind, t.fetchedAt)],
);

export const analyses = sqliteTable(
  "analyses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id),
    version: integer("version").notNull().default(1),
    modelVersion: text("model_version").notNull(),
    engineOutput: text("engine_output").notNull(), // JSON EngineOutput
    reportMd: text("report_md").notNull(),
    llmSections: text("llm_sections"), // JSON {thesis, drivers[], risks[], generatedAtVersion}
    inputSnapshotIds: text("input_snapshot_ids").notNull(), // JSON number[]
    status: text("status", { enum: ["draft", "published", "public", "void"] })
      .notNull()
      .default("draft"),
    contentHash: text("content_hash"),
    prevHash: text("prev_hash"),
    publishedAt: integer("published_at"),
    publicAt: integer("public_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("analyses_match_idx").on(t.matchId), index("analyses_status_idx").on(t.status)],
);

/** 按玩法拆出的可结算预测（战绩页直查），publish 时落库并锁定当时赔率 */
export const predictions = sqliteTable(
  "predictions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    analysisId: integer("analysis_id")
      .notNull()
      .references(() => analyses.id),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id),
    market: text("market", { enum: ["1x2", "ah", "ou"] }).notNull(),
    selection: text("selection").notNull(),
    line: real("line"),
    modelProb: real("model_prob").notNull(),
    oddsAtPublish: real("odds_at_publish"),
    /** 收盘赔率（结算时回填）：CLV = oddsAtPublish/closingOdds − 1，职业玩家核心指标 */
    closingOdds: real("closing_odds"),
    ev: real("ev"),
    kelly: real("kelly"),
    result: text("result", { enum: ["pending", "hit", "miss", "push", "void"] })
      .notNull()
      .default("pending"),
    settledAt: integer("settled_at"),
  },
  (t) => [
    index("pred_market_result_idx").on(t.market, t.result),
    index("pred_settled_idx").on(t.settledAt),
    index("pred_analysis_idx").on(t.analysisId),
  ],
);

/** 解锁按"比赛"计：一次付费覆盖该场赛前所有实时改版 */
export const unlocks = sqliteTable(
  "unlocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id),
    pointsSpent: integer("points_spent").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("unlocks_user_match_uq").on(t.userId, t.matchId),
    index("unlocks_match_idx").on(t.matchId),
  ],
);

export const outcomes = sqliteTable(
  "outcomes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id),
    homeGoals: integer("home_goals").notNull(),
    awayGoals: integer("away_goals").notNull(),
    htHome: integer("ht_home"),
    htAway: integer("ht_away"),
    finalStatus: text("final_status", { enum: ["finished", "abandoned", "postponed"] })
      .notNull()
      .default("finished"),
    source: text("source", { enum: ["csv", "llm", "manual", "espn", "api_football"] }).notNull(),
    /** AI 检索的赛果先标 provisional=1，管理员确认后置 0 才允许结算 */
    provisional: integer("provisional").notNull().default(0),
    recordedBy: integer("recorded_by"),
    recordedAt: integer("recorded_at").notNull(),
  },
  (t) => [uniqueIndex("outcomes_match_uq").on(t.matchId)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: integer("actor_id").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: integer("entity_id"),
    detail: text("detail"), // JSON
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("audit_time_idx").on(t.createdAt)],
);

/** 外部抓取缓存（按 URL 记内容哈希，未变不重复解析） */
export const fetchCache = sqliteTable("fetch_cache", {
  url: text("url").primaryKey(),
  contentHash: text("content_hash").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

/** 数据源健康账本：每源成败计数与连败数；连败达阈值自动停用（采集跳过），体检成功自动复活 */
export const sourceHealth = sqliteTable("source_health", {
  source: text("source").primaryKey(),
  okCount: integer("ok_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  consecutiveFails: integer("consecutive_fails").notNull().default(0),
  lastOkAt: integer("last_ok_at"),
  lastErrorAt: integer("last_error_at"),
  lastError: text("last_error"),
});

/* ════════════════════ V2 领域对象（REBUILD_PLAN 阶段 1-2） ════════════════════
 * 设计：12 张新表把对象链显性化；leagues/teams/matches/users.points/unlocks
 * 复用现有表（服务层映射 V2 语义），避免双写。旧表与旧接口保留（deprecated 渐退）。
 */

/** V2-1 数据源（从 SOURCE_REGISTRY 引导填充） */
export const providers = sqliteTable("providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["football_data", "odds", "weather", "news", "result", "dataset"] }).notNull(),
  status: text("status", { enum: ["active", "paused", "error"] }).notNull().default("active"),
  priority: integer("priority").notNull().default(100),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** V2-2 跨源实体 ID 映射（ESPN teamId / 竞彩中文名 等 → PlayTop 实体） */
export const providerEntityMap = sqliteTable(
  "provider_entity_map",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id").notNull().references(() => providers.id),
    entityType: text("entity_type", { enum: ["league", "team", "player", "match", "bookmaker", "market"] }).notNull(),
    providerEntityId: text("provider_entity_id").notNull(),
    playtopEntityId: integer("playtop_entity_id").notNull(),
    confidenceScore: real("confidence_score").notNull().default(1),
    lastCheckedAt: integer("last_checked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("pem_uq").on(t.providerId, t.entityType, t.providerEntityId)],
);

/** V2-6 原始 API 响应留档（全链路可追溯的地基；politeFetchText 统一落档） */
export const rawApiPayloads = sqliteTable(
  "raw_api_payloads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id"),
    endpoint: text("endpoint").notNull(),
    requestParamsJson: text("request_params_json"),
    responseJson: text("response_json"),
    httpStatus: integer("http_status"),
    fetchedAt: integer("fetched_at").notNull(),
    responseHash: text("response_hash"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("rap_endpoint_time_idx").on(t.endpoint, t.fetchedAt)],
);

/** V2-7 比赛研究快照（按时间档归并 data_snapshots 为一份完整研究底稿，链式哈希） */
export const matchSnapshots = sqliteTable(
  "match_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id").notNull().references(() => matches.id),
    snapshotType: text("snapshot_type", { enum: ["T72", "T24", "T6", "T1", "lineup", "lock", "post"] }).notNull(),
    capturedAt: integer("captured_at").notNull(),
    kickoffAt: integer("kickoff_at").notNull(),
    teamStateJson: text("team_state_json"),
    lineupJson: text("lineup_json"),
    injuryJson: text("injury_json"),
    weatherJson: text("weather_json"),
    standingsJson: text("standings_json"),
    statsJson: text("stats_json"),
    providerHealthJson: text("provider_health_json"),
    snapshotHash: text("snapshot_hash").notNull(),
    previousSnapshotHash: text("previous_snapshot_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ms_match_idx").on(t.matchId, t.capturedAt)],
);

/** V2-8 盘口快照（扁平化：一行 = 一家 × 一玩法 × 一方向） */
export const oddsSnapshots = sqliteTable(
  "odds_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id").notNull().references(() => matches.id),
    providerId: integer("provider_id"),
    bookmakerName: text("bookmaker_name").notNull(),
    marketType: text("market_type", { enum: ["one_x_two", "asian_handicap", "over_under", "correct_score"] }).notNull(),
    line: real("line"),
    selection: text("selection").notNull(),
    oddsDecimal: real("odds_decimal").notNull(),
    impliedProbability: real("implied_probability").notNull(),
    normalizedProbability: real("normalized_probability"),
    capturedAt: integer("captured_at").notNull(),
    isStale: integer("is_stale").notNull().default(0),
    oddsHash: text("odds_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("os_match_time_idx").on(t.matchId, t.capturedAt)],
);

/** V2-9 模型运行（一次引擎执行 = 一条；输入完整持久化，可精确重放） */
export const modelRuns = sqliteTable(
  "model_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id").notNull().references(() => matches.id),
    snapshotId: integer("snapshot_id").references(() => matchSnapshots.id),
    modelVersion: text("model_version").notNull(),
    inputJson: text("input_json").notNull(),
    inputHash: text("input_hash").notNull(),
    outputJson: text("output_json").notNull(),
    outputHash: text("output_hash").notNull(),
    status: text("status", { enum: ["success", "failed"] }).notNull(),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("mr_match_idx").on(t.matchId, t.createdAt)],
);

/** V2-10 研报版本（免费预览 + 付费正文 + 数字白名单留档） */
export const reportVersions = sqliteTable(
  "report_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id").notNull().references(() => matches.id),
    snapshotId: integer("snapshot_id").references(() => matchSnapshots.id),
    modelRunId: integer("model_run_id").references(() => modelRuns.id),
    versionType: text("version_type", { enum: ["T72", "T24", "T6", "T1", "lineup", "lock", "post"] }).notNull(),
    title: text("title").notNull(),
    freePreview: text("free_preview").notNull(),
    paidContent: text("paid_content").notNull(),
    summaryJson: text("summary_json").notNull(),
    numbersWhitelistJson: text("numbers_whitelist_json"),
    reportHash: text("report_hash").notNull(),
    previousReportHash: text("previous_report_hash"),
    isPublic: integer("is_public").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("rv_match_idx").on(t.matchId, t.createdAt)],
);

/** V2-11 开赛锁定记录（终版三元组 + 锁定哈希） */
export const reportLocks = sqliteTable("report_locks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  matchId: integer("match_id").notNull().unique().references(() => matches.id),
  finalSnapshotId: integer("final_snapshot_id").references(() => matchSnapshots.id),
  finalModelRunId: integer("final_model_run_id").references(() => modelRuns.id),
  finalReportVersionId: integer("final_report_version_id").references(() => reportVersions.id),
  lockedAt: integer("locked_at").notNull(),
  lockHash: text("lock_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** V2-12 赛后结算（逐观点：胜负/走水/半赢半输 + ROI/CLV/Brier） */
export const settlements = sqliteTable(
  "settlements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: integer("match_id").notNull().references(() => matches.id),
    reportLockId: integer("report_lock_id").references(() => reportLocks.id),
    finalResultJson: text("final_result_json").notNull(),
    opinionJson: text("opinion_json").notNull(),
    settlementResult: text("settlement_result", {
      enum: ["win", "lose", "push", "void", "half_win", "half_lose"],
    }).notNull(),
    roi: real("roi"),
    clv: real("clv"),
    brierScore: real("brier_score"),
    settledAt: integer("settled_at").notNull(),
    settlementHash: text("settlement_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("st_match_idx").on(t.matchId)],
);

/** V2-13 长期战绩物化（按 scope 维度聚合，结算后增量更新） */
export const trackRecords = sqliteTable(
  "track_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scopeType: text("scope_type", { enum: ["global", "league", "market", "rating", "period"] }).notNull(),
    scopeKey: text("scope_key").notNull(),
    totalMatches: integer("total_matches").notNull().default(0),
    publishedOpinions: integer("published_opinions").notNull().default(0),
    watchOnlyCount: integer("watch_only_count").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    pushes: integer("pushes").notNull().default(0),
    roi: real("roi"),
    clv: real("clv"),
    maxDrawdown: real("max_drawdown"),
    brierScore: real("brier_score"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("tr_scope_uq").on(t.scopeType, t.scopeKey)],
);

/** V2-16 通用审计哈希链（V2 实体统一链式存证） */
export const auditHashes = sqliteTable(
  "audit_hashes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    hashValue: text("hash_value").notNull(),
    previousHash: text("previous_hash"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("ah_entity_idx").on(t.entityType, t.entityId)],
);

/** V2-17 数据源健康账本（按 provider 维度的时间序列体检记录） */
export const dataProviderHealth = sqliteTable(
  "data_provider_health",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id").notNull().references(() => providers.id),
    checkedAt: integer("checked_at").notNull(),
    latencyMs: integer("latency_ms"),
    missingRate: real("missing_rate"),
    errorRate: real("error_rate"),
    abnormalCount: integer("abnormal_count").notNull().default(0),
    status: text("status", { enum: ["active", "paused", "error"] }).notNull(),
    healthScore: real("health_score"),
    detailsJson: text("details_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("dph_provider_time_idx").on(t.providerId, t.checkedAt)],
);
