/**
 * 数据层落库:赛程缓存、odds/predictions 快照归档(AF 赛前 odds 仅 1–14 天窗口,
 * 必须平台自有库持续归档)、相邻快照 diff 生成「异动」、模型战绩结算。
 */
import { db, tx } from "../db";
import { detectMovement, normalizeOddsItem } from "./normalize";
import { isDisplayableSnapshot, LIVE_EU_DISPLAY_MAX_ODD } from "./odds-quality";
import { ODDS_PARSER_VERSION, recordDiagnosticIssue } from "./diagnostics";
import { isFinished } from "./schedule";
import { ahText, ouText } from "@/lib/format";

/* 书商中文名(界面用);未登记的保留原名 */
const BOOKMAKER_ZH: [RegExp, string][] = [
  [/bet365/i, "Bet365"],
  [/pinnacle/i, "平博"],
  [/marathon/i, "马拉松"],
  [/bwin/i, "Bwin"],
  [/1xbet/i, "1xBet"],
  [/betfair/i, "必发"],
  [/william/i, "威廉希尔"],
  [/unibet/i, "Unibet"],
];
export function bookmakerZh(name: string): string {
  for (const [re, zh] of BOOKMAKER_ZH) if (re.test(name)) return zh;
  return name;
}
/** 主源书商优先级(列表/走势的「主盘」同线下优先取第一个有数据的) */
export const PRIMARY_BOOKMAKERS = ["Bet365", "平博", "马拉松", "Bwin", "1xBet", "必发"];

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const FIXTURE_DETAIL_KEYS = ["events", "statistics", "lineups", "players"] as const;

function fixturePayloadForUpsert(id: number, item: unknown): Record<string, unknown> {
  const next = item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : {};
  const fx = fixtureById(id);
  if (!fx) return next;
  let prev: Record<string, unknown> = {};
  try {
    prev = JSON.parse(fx.payload) as Record<string, unknown>;
  } catch {
    prev = {};
  }
  for (const key of FIXTURE_DETAIL_KEYS) {
    if (asArr(next[key]).length === 0 && asArr(prev[key]).length > 0) next[key] = prev[key];
  }
  return next;
}

/* ── 赛程 ── */

export interface FixtureRow {
  fixture_id: number;
  league_id: number;
  season: number;
  league_name: string;
  round: string;
  kickoff_utc: number;
  status: string;
  elapsed: number | null;
  home_id: number | null;
  home_name: string;
  away_id: number | null;
  away_name: string;
  goals_home: number | null;
  goals_away: number | null;
  payload: string;
  updated_at: number;
}

/** /fixtures response 项 → upsert(payload 整体存档,详情页要用 events/lineups 等) */
export function upsertFixture(item: unknown): number | null {
  const id = Number(dig(item, "fixture", "id"));
  if (!id) return null;
  const kickoffIso = dig(item, "fixture", "date") as string | undefined;
  const kickoff = kickoffIso ? Date.parse(kickoffIso) : NaN;
  if (!Number.isFinite(kickoff)) return null;
  db()
    .prepare(
      `INSERT INTO fixtures_cache (fixture_id, league_id, season, league_name, round, kickoff_utc, status, elapsed,
         home_id, home_name, away_id, away_name, goals_home, goals_away, payload, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fixture_id) DO UPDATE SET
         league_id=excluded.league_id, season=excluded.season, league_name=excluded.league_name, round=excluded.round,
         kickoff_utc=excluded.kickoff_utc, status=excluded.status, elapsed=excluded.elapsed,
         home_id=excluded.home_id, home_name=excluded.home_name, away_id=excluded.away_id, away_name=excluded.away_name,
         goals_home=excluded.goals_home, goals_away=excluded.goals_away,
         payload=excluded.payload,
         updated_at=excluded.updated_at`,
    )
    .run(
      id,
      Number(dig(item, "league", "id")) || 0,
      Number(dig(item, "league", "season")) || 0,
      String(dig(item, "league", "name") ?? ""),
      String(dig(item, "league", "round") ?? ""),
      kickoff,
      String(dig(item, "fixture", "status", "short") ?? "NS"),
      (dig(item, "fixture", "status", "elapsed") as number | null) ?? null,
      Number(dig(item, "teams", "home", "id")) || null,
      String(dig(item, "teams", "home", "name") ?? ""),
      Number(dig(item, "teams", "away", "id")) || null,
      String(dig(item, "teams", "away", "name") ?? ""),
      (dig(item, "goals", "home") as number | null) ?? null,
      (dig(item, "goals", "away") as number | null) ?? null,
      JSON.stringify(fixturePayloadForUpsert(id, item)),
      Date.now(),
    );
  return id;
}

export function fixtureById(id: number): FixtureRow | null {
  return (db().prepare("SELECT * FROM fixtures_cache WHERE fixture_id = ?").get(id) as FixtureRow | undefined) ?? null;
}

/** 将 AF 独立详情端点(events/statistics/lineups/players 等)并入已缓存 fixture payload。 */
export function mergeFixturePayload(fixtureId: number, patch: Record<string, unknown>, updatedAt = Date.now()): boolean {
  const fx = fixtureById(fixtureId);
  if (!fx) return false;
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(fx.payload) as Record<string, unknown>;
  } catch {
    base = {};
  }
  const next = { ...base, ...patch };
  db().prepare("UPDATE fixtures_cache SET payload = ?, updated_at = ? WHERE fixture_id = ?").run(JSON.stringify(next), updatedAt, fixtureId);
  return true;
}

export function fixturesBetween(fromUtc: number, toUtc: number): FixtureRow[] {
  return db()
    .prepare("SELECT * FROM fixtures_cache WHERE kickoff_utc >= ? AND kickoff_utc < ? ORDER BY kickoff_utc")
    .all(fromUtc, toUtc) as unknown as FixtureRow[];
}

/* ── 赔率快照与异动 ── */

export interface SnapRow {
  fixture_id: number;
  bookmaker_id: number;
  bookmaker: string;
  market: string;
  line: number | null;
  h: number;
  a: number;
  d: number | null;
  captured_at: number;
}

export type OddsMarket = "ah" | "ou" | "eu";

export interface OddsCompareRow {
  bookmaker: string;
  first: SnapRow;
  last: SnapRow;
}

export interface OddsBundle {
  ah: SnapRow[];
  ou: SnapRow[];
  eu: SnapRow[];
  compareAh: OddsCompareRow[];
  compareOu: OddsCompareRow[];
  compareEu: OddsCompareRow[];
}

export interface MainOddsDecision {
  market: OddsMarket;
  rows: SnapRow[];
  source: SnapRow | null;
  books: number;
  selectedBooks: number;
  primaryBooks: number;
  qualityScore: number;
  reason: string;
  warnings: string[];
}

export interface AfRawPayloadInput {
  endpoint: "odds" | "odds.live" | "fixtures" | "predictions" | "fixtures.statistics" | "fixtures.events" | "fixtures.lineups" | "fixtures.players";
  fixtureId?: number | null;
  requestParams?: Record<string, unknown> | null;
  payload: unknown;
  responseStatus?: number | null;
  bookmakerId?: number | null;
  betId?: number | null;
  fetchedAt?: number;
}

function bookmakerRank(name: string): number {
  const i = PRIMARY_BOOKMAKERS.indexOf(name);
  return i < 0 ? 99 : i;
}

function bookmakerWeight(name: string): number {
  const rank = bookmakerRank(name);
  if (rank === 0) return 5;
  if (rank <= 2) return 4;
  if (rank <= 5) return 3;
  return 1;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

function insertAfRawPayload(d: ReturnType<typeof db>, input: AfRawPayloadInput): void {
  d.prepare(
    `INSERT INTO af_raw_payloads
      (source, endpoint, request_params, response_status, fixture_id, bookmaker_id, bet_id, parser_version, payload, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "API_FOOTBALL",
    input.endpoint,
    JSON.stringify(input.requestParams ?? {}),
    input.responseStatus ?? null,
    input.fixtureId ?? null,
    input.bookmakerId ?? null,
    input.betId ?? null,
    ODDS_PARSER_VERSION,
    JSON.stringify(input.payload),
    input.fetchedAt ?? Date.now(),
  );
}

/** 可追溯 raw 信封:记录 endpoint/请求参数/解析版本,用于线上错盘回放。 */
export function archiveAfRawPayload(input: AfRawPayloadInput): void {
  insertAfRawPayload(db(), input);
}

function rowsByBookmaker(rows: SnapRow[]): Map<string, SnapRow[]> {
  const byBook = new Map<string, SnapRow[]>();
  for (const row of rows) {
    const list = byBook.get(row.bookmaker) ?? [];
    list.push(row);
    byBook.set(row.bookmaker, list);
  }
  return byBook;
}

function qualityScore(args: { books: number; selectedBooks: number; primaryBooks: number; latestAt: number | null }): number {
  if (args.selectedBooks === 0) return 0;
  let score = 62;
  score += Math.min(24, args.selectedBooks * 5);
  score += Math.min(10, args.primaryBooks * 5);
  score += Math.min(8, Math.max(0, args.books - args.selectedBooks));
  if (args.latestAt) {
    const age = Date.now() - args.latestAt;
    if (age <= 15 * 60_000) score += 8;
    else if (age <= 30 * 60_000) score += 4;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 从某场某市场全量快照内选择主盘口,并返回可审计的选择原因。 */
export function mainOddsDecisionFromRows(rows: SnapRow[], market: OddsMarket): MainOddsDecision {
  const empty = (reason = "暂无可用快照"): MainOddsDecision => ({
    market,
    rows: [],
    source: null,
    books: 0,
    selectedBooks: 0,
    primaryBooks: 0,
    qualityScore: 0,
    reason,
    warnings: [reason],
  });
  if (rows.length === 0) return empty();
  const validRows = rows.filter((row) => isDisplayableSnapshot(market, row));
  if (validRows.length === 0) return empty("没有通过质量门禁的完整盘口");
  const byBook = rowsByBookmaker(validRows);
  const latestRows = [...byBook.values()].map((list) => list[list.length - 1]).filter(Boolean);
  if (latestRows.length === 0) return empty();
  if (market === "eu") {
    const sorted = [...latestRows].sort((x, y) => bookmakerRank(x.bookmaker) - bookmakerRank(y.bookmaker) || y.captured_at - x.captured_at);
    const source = sorted[0] ?? null;
    const primaryBooks = latestRows.filter((row) => bookmakerRank(row.bookmaker) <= 2).length;
    const q = qualityScore({ books: latestRows.length, selectedBooks: latestRows.length, primaryBooks, latestAt: source?.captured_at ?? null });
    const warnings = latestRows.length < 3 ? ["胜平负样本少于 3 家,仅作单源参考"] : [];
    return {
      market,
      rows: source ? byBook.get(source.bookmaker) ?? [] : [],
      source,
      books: latestRows.length,
      selectedBooks: latestRows.length,
      primaryBooks,
      qualityScore: q,
      reason: source ? `胜平负无盘口线,按主流书商优先展示 ${source.bookmaker};共 ${latestRows.length} 家` : "胜平负暂无完整快照",
      warnings,
    };
  }
  const lined = latestRows.filter((r) => r.line != null);
  if (lined.length === 0) return empty("没有合法盘口线");
  const byLine = new Map<number, SnapRow[]>();
  for (const row of lined) {
    const line = row.line as number;
    const list = byLine.get(line) ?? [];
    list.push(row);
    byLine.set(line, list);
  }
  const scored = [...byLine.entries()].map(([line, list]) => {
    const weights = list.reduce((sum, row) => sum + bookmakerWeight(row.bookmaker), 0);
    const primary = list.filter((row) => bookmakerRank(row.bookmaker) <= 2).length;
    const balance = list.reduce((sum, row) => sum + Math.abs(row.h - row.a), 0) / list.length;
    const latest = Math.max(...list.map((row) => row.captured_at));
    return { line, list, count: list.length, weights, primary, balance, latest };
  });
  const maxCount = Math.max(...scored.map((s) => s.count));
  const closeWindow = Math.max(1, Math.ceil(maxCount * 0.25));
  const candidates = scored.filter((s) => maxCount - s.count <= closeWindow);
  candidates.sort(
    (x, y) =>
      y.primary - x.primary ||
      y.weights - x.weights ||
      y.count - x.count ||
      x.balance - y.balance ||
      y.latest - x.latest ||
      Math.abs(x.line) - Math.abs(y.line),
  );
  const best = candidates[0] ?? null;
  if (!best) return empty("没有可选主盘口");
  const source = [...best.list].sort((x, y) => bookmakerRank(x.bookmaker) - bookmakerRank(y.bookmaker) || y.captured_at - x.captured_at)[0] ?? null;
  const q = qualityScore({ books: latestRows.length, selectedBooks: best.count, primaryBooks: best.primary, latestAt: best.latest });
  const warnings: string[] = [];
  if (q < 70) warnings.push("质量分低于展示阈值");
  if (best.count < 3) warnings.push("同线覆盖少于 3 家");
  return {
    market,
    rows: source ? byBook.get(source.bookmaker) ?? [] : [],
    source,
    books: latestRows.length,
    selectedBooks: best.count,
    primaryBooks: best.primary,
    qualityScore: q,
    reason: `共识线 ${best.line}:覆盖 ${best.count}/${latestRows.length} 家,主流 ${best.primary} 家,展示源 ${source?.bookmaker ?? "—"}`,
    warnings,
  };
}

/** 从某场某市场全量快照内选出列表/走势主盘序列;供批量视图复用同一口径。 */
export function mainOddsSeriesFromRows(rows: SnapRow[], market: OddsMarket): SnapRow[] {
  const decision = mainOddsDecisionFromRows(rows, market);
  return decision.qualityScore >= 70 ? decision.rows : [];
}

/** 从某场某市场全量快照生成百家对比首帧/即时盘。 */
export function oddsCompareFromRows(rows: SnapRow[], market?: OddsMarket): OddsCompareRow[] {
  const validRows = rows.filter((row) => isDisplayableSnapshot(market ?? (row.market as OddsMarket), row));
  return [...rowsByBookmaker(validRows).entries()]
    .sort((x, y) => bookmakerRank(x[0]) - bookmakerRank(y[0]))
    .map(([bookmaker, list]) => ({ bookmaker, first: list[0], last: list[list.length - 1] }));
}

/**
 * 归档一次 /odds 拉取:原始 payload 落 odds_raw,归一化落 odds_snapshots,
 * 与同书商同市场上一帧 diff → movements。返回新增异动数。
 */
export function archiveOdds(fixtureId: number, oddsItem: unknown, capturedAt = Date.now(), opts: { persistRaw?: boolean } = {}): number {
  const sourceFixtureId = Number(dig(oddsItem, "fixture", "id")) || null;
  const fixtureMismatch = sourceFixtureId != null && sourceFixtureId !== fixtureId;
  if (fixtureMismatch) {
    recordDiagnosticIssue({
      endpoint: "odds",
      fixtureId,
      rawValue: { sourceFixtureId, targetFixtureId: fixtureId },
      errorType: "FIXTURE_MISMATCH",
      errorReason: "AF odds fixture_id 与目标 fixture 不一致,拒绝进入标准盘口",
      severity: "error",
    });
  }
  const books = fixtureMismatch ? [] : normalizeOddsItem(oddsItem, { fixtureId, onIssue: recordDiagnosticIssue });
  return tx(() => {
    const d = db();
    // 原始 AF 包先落库:即使当前归一化没有吃到市场,后续也能重放排查解析/玩法口径问题。
    if (opts.persistRaw !== false) {
      insertAfRawPayload(d, {
        endpoint: "odds",
        fixtureId,
        requestParams: { fixture: fixtureId },
        payload: oddsItem,
        fetchedAt: capturedAt,
      });
      d.prepare("INSERT INTO odds_raw (fixture_id, payload, captured_at) VALUES (?,?,?)").run(
        fixtureId, JSON.stringify(oddsItem), capturedAt,
      );
    }
    if (books.length === 0) return 0;
    let moves = 0;
    const prevStmt = d.prepare(
      "SELECT * FROM odds_snapshots WHERE fixture_id = ? AND bookmaker_id = ? AND market = ? ORDER BY captured_at DESC LIMIT 1",
    );
    const insStmt = d.prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const movStmt = d.prepare(
      `INSERT INTO movements (fixture_id, market, bookmaker, type, from_line, to_line, from_h, to_h, from_a, to_a, sev, t0, t1)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const bm of books) {
      const zh = bookmakerZh(bm.bookmaker);
      for (const mk of bm.markets) {
        const prev = prevStmt.get(fixtureId, bm.bookmakerId, mk.market) as SnapRow | undefined;
        // 同帧重复(数值完全一致)只在间隔 >10min 时补点,避免快照表膨胀
        if (prev && prev.line === mk.line && prev.h === mk.h && prev.a === mk.a && prev.d === mk.d && capturedAt - prev.captured_at < 600_000) {
          continue;
        }
        insStmt.run(fixtureId, bm.bookmakerId, zh, mk.market, mk.line, mk.h, mk.a, mk.d, capturedAt);
        if (prev && (mk.market === "ah" || mk.market === "ou") && prev.line != null && mk.line != null) {
          const mv = detectMovement(mk.market, { line: prev.line, h: prev.h, a: prev.a }, { line: mk.line, h: mk.h, a: mk.a });
          if (mv) {
            movStmt.run(fixtureId, mv.market, zh, mv.type, mv.fromLine, mv.toLine, mv.fromH, mv.toH, mv.fromA, mv.toA, mv.sev ? 1 : 0, prev.captured_at, capturedAt);
            moves++;
          }
        }
      }
    }
    return moves;
  });
}

/**
 * 某场某市场主盘:各书商最新帧先形成共识盘口,再在共识盘口内按主流书商优先级选展示源。
 * 这样避免冷门书商晚几分钟更新时,把离群线误当成全站主盘。
 */
export function mainOddsSnapshot(fixtureId: number, market: OddsMarket): SnapRow | null {
  const series = oddsSeries(fixtureId, market);
  return series[series.length - 1] ?? null;
}

/** 某场某市场主盘口决策说明:后台诊断/后续 MarketOverview 复用。 */
export function mainOddsDecision(fixtureId: number, market: OddsMarket): MainOddsDecision {
  const rows = db()
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? ORDER BY bookmaker, captured_at")
    .all(fixtureId, market) as unknown as SnapRow[];
  return mainOddsDecisionFromRows(rows, market);
}

/** 某场某市场截止时刻前的主盘口决策:报告/回测锁定开赛前最后一版。 */
export function mainOddsDecisionBefore(fixtureId: number, market: OddsMarket, cutoffAt: number): MainOddsDecision {
  const rows = db()
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? AND captured_at <= ? ORDER BY bookmaker, captured_at")
    .all(fixtureId, market, cutoffAt) as unknown as SnapRow[];
  return mainOddsDecisionFromRows(rows, market);
}

/** 某场某市场的主盘快照序列:全部书商数据都在,百家对比可查任一家。 */
export function oddsSeries(fixtureId: number, market: OddsMarket): SnapRow[] {
  const rows = db()
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? ORDER BY bookmaker, captured_at")
    .all(fixtureId, market) as unknown as SnapRow[];
  return mainOddsSeriesFromRows(rows, market);
}

/** 多场同市场主盘序列批量查询,供列表型接口避免逐场扫 odds_snapshots。 */
export function oddsSeriesBatch(fixtureIds: number[], market: OddsMarket): Map<number, SnapRow[]> {
  const ids = [...new Set(fixtureIds)];
  const result = new Map<number, SnapRow[]>();
  if (ids.length === 0) return result;
  const rows = db()
    .prepare(`SELECT * FROM odds_snapshots WHERE market = ? AND fixture_id IN (${placeholders(ids.length)}) ORDER BY fixture_id, bookmaker, captured_at`)
    .all(market, ...ids) as unknown as SnapRow[];
  const byFixture = new Map<number, SnapRow[]>();
  for (const row of rows) {
    const series = byFixture.get(row.fixture_id) ?? [];
    series.push(row);
    byFixture.set(row.fixture_id, series);
  }
  for (const [fixtureId, series] of byFixture) result.set(fixtureId, mainOddsSeriesFromRows(series, market));
  return result;
}

function oddsByMarket(fixtureId: number, cutoffAt?: number | null): Record<OddsMarket, SnapRow[]> {
  const rows =
    cutoffAt == null
      ? (db()
          .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? ORDER BY market, bookmaker, captured_at")
          .all(fixtureId) as unknown as SnapRow[])
      : (db()
          .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND captured_at <= ? ORDER BY market, bookmaker, captured_at")
          .all(fixtureId, cutoffAt) as unknown as SnapRow[]);
  return {
    ah: rows.filter((r) => r.market === "ah"),
    ou: rows.filter((r) => r.market === "ou"),
    eu: rows.filter((r) => r.market === "eu"),
  };
}

/** 详情页一次性取齐盘口走势与百家对比,避免同一场反复扫 odds_snapshots。 */
export function oddsBundle(fixtureId: number): OddsBundle {
  const rows = oddsByMarket(fixtureId);
  return oddsBundleFromRows(rows);
}

/** 详情/报告的赛前固化口径:只读取 cutoffAt 之前的快照。 */
export function oddsBundleBefore(fixtureId: number, cutoffAt: number): OddsBundle {
  const rows = oddsByMarket(fixtureId, cutoffAt);
  return oddsBundleFromRows(rows);
}

function oddsBundleFromRows(rows: Record<OddsMarket, SnapRow[]>): OddsBundle {
  return {
    ah: mainOddsSeriesFromRows(rows.ah, "ah"),
    ou: mainOddsSeriesFromRows(rows.ou, "ou"),
    eu: mainOddsSeriesFromRows(rows.eu, "eu"),
    compareAh: oddsCompareFromRows(rows.ah, "ah"),
    compareOu: oddsCompareFromRows(rows.ou, "ou"),
    compareEu: oddsCompareFromRows(rows.eu, "eu"),
  };
}

/** 多场同市场主盘序列批量查询,并按每场 cutoff 截止。 */
export function oddsSeriesBatchBefore(fixtureIds: number[], market: OddsMarket, cutoffByFixture: Map<number, number>): Map<number, SnapRow[]> {
  const ids = [...new Set(fixtureIds)];
  const result = new Map<number, SnapRow[]>();
  if (ids.length === 0) return result;
  const rows = db()
    .prepare(`SELECT * FROM odds_snapshots WHERE market = ? AND fixture_id IN (${placeholders(ids.length)}) ORDER BY fixture_id, bookmaker, captured_at`)
    .all(market, ...ids) as unknown as SnapRow[];
  const byFixture = new Map<number, SnapRow[]>();
  for (const row of rows) {
    const cutoffAt = cutoffByFixture.get(row.fixture_id) ?? Number.POSITIVE_INFINITY;
    if (row.captured_at > cutoffAt) continue;
    const series = byFixture.get(row.fixture_id) ?? [];
    series.push(row);
    byFixture.set(row.fixture_id, series);
  }
  for (const [fixtureId, series] of byFixture) result.set(fixtureId, mainOddsSeriesFromRows(series, market));
  return result;
}

/** 各书商归档首帧/即时盘(百家对比) */
export function oddsCompare(fixtureId: number, market: OddsMarket): OddsCompareRow[] {
  const rows = db()
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? ORDER BY captured_at")
    .all(fixtureId, market) as unknown as SnapRow[];
  return oddsCompareFromRows(rows, market);
}

export interface MovementRow {
  id: number;
  fixture_id: number;
  market: string;
  bookmaker: string;
  type: string;
  from_line: number;
  to_line: number;
  from_h: number;
  to_h: number;
  from_a: number;
  to_a: number;
  sev: number;
  t0: number;
  t1: number;
  phase: string; // 盘前 | 滚球
}

export function recentMovements(limit = 80, type?: string): (MovementRow & { home_name: string; away_name: string; league_name: string; league_id: number })[] {
  // type 既支持异动类型(升盘/降盘/水位)也支持阶段筛选(滚球)
  const clauses = [
    "NOT (m.market = 'eu' AND m.phase = '滚球' AND (m.from_h > ? OR m.to_h > ? OR m.from_a > ? OR m.to_a > ?))",
  ];
  const args: (number | string)[] = [LIVE_EU_DISPLAY_MAX_ODD, LIVE_EU_DISPLAY_MAX_ODD, LIVE_EU_DISPLAY_MAX_ODD, LIVE_EU_DISPLAY_MAX_ODD];
  if (type === "滚球") {
    clauses.push("m.phase = ?");
    args.push(type);
  } else if (type && type !== "全部") {
    clauses.push("m.type = ?");
    args.push(type);
  }
  args.push(limit);
  const where = `WHERE ${clauses.join(" AND ")}`;
  return db()
    .prepare(
      `SELECT m.*, f.home_name, f.away_name, f.league_name, f.league_id
       FROM movements m JOIN fixtures_cache f ON f.fixture_id = m.fixture_id
       ${where} ORDER BY m.t1 DESC LIMIT ?`,
    )
    .all(...args) as unknown as (MovementRow & { home_name: string; away_name: string; league_name: string; league_id: number })[];
}

export function movementsOf(fixtureId: number): MovementRow[] {
  return db().prepare("SELECT * FROM movements WHERE fixture_id = ? ORDER BY t1 DESC").all(fixtureId) as unknown as MovementRow[];
}

/* ── 预测快照 ── */

export function archivePrediction(fixtureId: number, payload: unknown, capturedAt = Date.now()): void {
  db().prepare("INSERT INTO predictions_snapshots (fixture_id, payload, captured_at) VALUES (?,?,?)").run(
    fixtureId, JSON.stringify(payload), capturedAt,
  );
}

export function latestPrediction(fixtureId: number): unknown | null {
  const r = db()
    .prepare("SELECT payload FROM predictions_snapshots WHERE fixture_id = ? ORDER BY captured_at DESC LIMIT 1")
    .get(fixtureId) as { payload: string } | undefined;
  return parsePredictionPayload(r?.payload);
}

export function latestPredictionBefore(fixtureId: number, cutoffAt: number): unknown | null {
  const r = db()
    .prepare("SELECT payload FROM predictions_snapshots WHERE fixture_id = ? AND captured_at <= ? ORDER BY captured_at DESC, id DESC LIMIT 1")
    .get(fixtureId, cutoffAt) as { payload: string } | undefined;
  return parsePredictionPayload(r?.payload);
}

function parsePredictionPayload(payload?: string): unknown | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** 多场最新预测快照批量查询;解析失败等同无官方可用预测。 */
export function latestPredictionsMap(fixtureIds: number[]): Map<number, unknown> {
  const ids = [...new Set(fixtureIds)];
  const result = new Map<number, unknown>();
  if (ids.length === 0) return result;
  const rows = db()
    .prepare(
      `SELECT p.fixture_id, p.payload
       FROM predictions_snapshots p
       JOIN (
         SELECT fixture_id, MAX(captured_at) captured_at
         FROM predictions_snapshots
         WHERE fixture_id IN (${placeholders(ids.length)})
         GROUP BY fixture_id
       ) latest ON latest.fixture_id = p.fixture_id AND latest.captured_at = p.captured_at
       ORDER BY p.fixture_id, p.id DESC`,
    )
    .all(...ids) as unknown as { fixture_id: number; payload: string }[];
  for (const row of rows) {
    if (result.has(row.fixture_id)) continue;
    try {
      result.set(row.fixture_id, JSON.parse(row.payload));
    } catch {
      /* 无法解析则视为暂无可用预测 */
    }
  }
  return result;
}

/** 多场预测快照批量查询,并按每场 cutoff 取最后一版赛前快照。 */
export function latestPredictionsBeforeMap(fixtureIds: number[], cutoffByFixture: Map<number, number>): Map<number, unknown> {
  const ids = [...new Set(fixtureIds)];
  const result = new Map<number, unknown>();
  if (ids.length === 0) return result;
  const rows = db()
    .prepare(
      `SELECT fixture_id, payload, captured_at
       FROM predictions_snapshots
       WHERE fixture_id IN (${placeholders(ids.length)})
       ORDER BY fixture_id, captured_at DESC, id DESC`,
    )
    .all(...ids) as unknown as { fixture_id: number; payload: string; captured_at: number }[];
  for (const row of rows) {
    if (result.has(row.fixture_id)) continue;
    const cutoffAt = cutoffByFixture.get(row.fixture_id) ?? Number.POSITIVE_INFINITY;
    if (row.captured_at > cutoffAt) continue;
    const parsed = parsePredictionPayload(row.payload);
    if (parsed != null) result.set(row.fixture_id, parsed);
  }
  return result;
}

export function hasPrediction(fixtureId: number): boolean {
  return !!db().prepare("SELECT 1 FROM predictions_snapshots WHERE fixture_id = ? LIMIT 1").get(fixtureId);
}

/* ── 模型战绩(预测对照赛果自动统计)── */

type PickSide = "home" | "away";
type TotalSide = "over" | "under";

function predObject(pred: unknown): Record<string, unknown> | null {
  if (!pred) return null;
  return (Array.isArray(pred) ? pred[0] : pred) as Record<string, unknown>;
}

function ahSideFromFixtureLine(line: number | null): PickSide | null {
  if (line == null || line === 0) return null;
  return line > 0 ? "home" : "away";
}

function ahPickText(fx: FixtureRow, side: PickSide, line: number | null): string {
  if (line == null) return side === "home" ? fx.home_name : fx.away_name;
  const fav = ahSideFromFixtureLine(line);
  const role = fav == null ? "平手" : fav === side ? `让${ahText(Math.abs(line))}` : `受让${ahText(Math.abs(line))}`;
  return `${side === "home" ? fx.home_name : fx.away_name} ${role}`;
}

function ouPickText(side: TotalSide, line: number | null): string {
  return line == null ? (side === "over" ? "大球方向" : "小球方向") : `${side === "over" ? "大于" : "小于"} ${ouText(line)}`;
}

function asianHit(fx: FixtureRow, side: PickSide, line: number | null): number | null {
  if (line == null || fx.goals_home == null || fx.goals_away == null) return null;
  const margin = fx.goals_home - fx.goals_away;
  const delta = side === "home" ? margin - line : -margin + line;
  return delta > 0 ? 1 : delta < 0 ? 0 : null;
}

function totalHit(fx: FixtureRow, side: TotalSide, line: number | null): number | null {
  if (line == null || fx.goals_home == null || fx.goals_away == null) return null;
  const delta = fx.goals_home + fx.goals_away - line;
  return side === "over" ? (delta > 0 ? 1 : delta < 0 ? 0 : null) : delta < 0 ? 1 : delta > 0 ? 0 : null;
}

/** 完场结算:用开赛前最后一帧预测/指数快照对照终局比分,避免赛中数据污染回测。 */
export function settleFixture(fx: FixtureRow): void {
  if (!isFinished(fx.status) || fx.goals_home == null || fx.goals_away == null) return;
  const d = db();
  if (d.prepare("SELECT 1 FROM model_records WHERE fixture_id = ?").get(fx.fixture_id)) return;
  const basisAt = fx.kickoff_utc - 1;
  const p = predObject(latestPredictionBefore(fx.fixture_id, basisAt));
  if (!p) return;
  const odds = oddsBundleBefore(fx.fixture_id, basisAt);
  const ah = odds.ah.at(-1) ?? null;
  const ou = odds.ou.at(-1) ?? null;
  const winnerId = Number(dig(p, "predictions", "winner", "id")) || null;
  const winDraw = Boolean(dig(p, "predictions", "win_or_draw"));
  const winnerSide: PickSide | null = winnerId === fx.home_id ? "home" : winnerId === fx.away_id ? "away" : null;
  const ahSide: PickSide | null =
    winnerSide ??
    (ah && ah.h !== ah.a ? (ah.h < ah.a ? "home" : "away") : ah ? ahSideFromFixtureLine(ah.line) : null);
  const rawUo = dig(p, "predictions", "under_over");
  const rawUoNum = rawUo == null ? NaN : parseFloat(String(rawUo));
  const ouSide: TotalSide | null = Number.isFinite(rawUoNum)
    ? rawUoNum < 0
      ? "under"
      : "over"
    : ou && ou.h !== ou.a
      ? ou.h < ou.a
        ? "over"
        : "under"
      : null;
  if (!winnerSide && !ahSide && !ouSide) return;
  const pick = winnerSide ? (winnerSide === "home" ? fx.home_name : fx.away_name) + (winDraw ? "(双重机会)" : "胜") : "暂无胜平负方向";
  const diff = fx.goals_home - fx.goals_away;
  const hit =
    winnerSide == null
      ? null
      : winnerSide === "home"
        ? winDraw
          ? diff >= 0
          : diff > 0
        : winDraw
          ? diff <= 0
          : diff < 0;
  const ahPick = ahSide ? ahPickText(fx, ahSide, ah?.line ?? null) : null;
  const ouPick = ouSide ? ouPickText(ouSide, ou?.line ?? null) : null;
  const date = new Date(fx.kickoff_utc + 8 * 3_600_000).toISOString().slice(0, 10); // 平台运营时区 UTC+8
  d.prepare(
    `INSERT INTO model_records
      (fixture_id, date, match_name, pick, score, hit, settled_at, basis_at, ah_pick, ah_hit, ou_pick, ou_hit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    fx.fixture_id,
    date,
    `${fx.home_name} vs ${fx.away_name}`,
    pick,
    `${fx.goals_home}-${fx.goals_away}`,
    hit == null ? null : hit ? 1 : 0,
    Date.now(),
    basisAt,
    ahPick,
    ahSide ? asianHit(fx, ahSide, ah?.line ?? null) : null,
    ouPick,
    ouSide ? totalHit(fx, ouSide, ou?.line ?? null) : null,
  );
}

export interface ModelStats {
  hitRate30: number | null;
  yesterday: { hit: number; total: number };
  streak: number;
  week: { date: string; hit: number; total: number }[];
  yesterdayRows: { match: string; pick: string; score: string; hit: number; ahPick?: string | null; ahHit?: number | null; ouPick?: string | null; ouHit?: number | null }[];
}

export function modelStats(nowMs = Date.now()): ModelStats {
  const d = db();
  const day = (offset: number) => new Date(nowMs + 8 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);
  const since30 = day(30);
  const all30 = d
    .prepare("SELECT date, match_name, pick, score, hit, ah_pick, ah_hit, ou_pick, ou_hit FROM model_records WHERE date >= ? AND hit IS NOT NULL ORDER BY settled_at")
    .all(since30) as { date: string; match_name: string; pick: string; score: string; hit: number; ah_pick?: string | null; ah_hit?: number | null; ou_pick?: string | null; ou_hit?: number | null }[];
  const hitRate30 = all30.length > 0 ? Math.round((all30.filter((r) => r.hit).length / all30.length) * 1000) / 10 : null;
  const yesterdayDate = day(1);
  const yRows = all30.filter((r) => r.date === yesterdayDate);
  let streak = 0;
  for (let i = all30.length - 1; i >= 0 && all30[i].hit; i--) streak++;
  const byDate = new Map<string, { hit: number; total: number }>();
  for (const row of all30) {
    const current = byDate.get(row.date) ?? { hit: 0, total: 0 };
    current.total++;
    if (row.hit) current.hit++;
    byDate.set(row.date, current);
  }
  const week = Array.from({ length: 7 }, (_, i) => {
    const dt = day(6 - i);
    return { date: dt, ...(byDate.get(dt) ?? { hit: 0, total: 0 }) };
  });
  return {
    hitRate30,
    yesterday: { hit: yRows.filter((r) => r.hit).length, total: yRows.length },
    streak,
    week,
    yesterdayRows: yRows.map((r) => ({ match: r.match_name, pick: r.pick, score: r.score, hit: r.hit, ahPick: r.ah_pick, ahHit: r.ah_hit, ouPick: r.ou_pick, ouHit: r.ou_hit })),
  };
}

/** 最新一帧原始赔率包(全书商全玩法;扩展玩法读时解析用) */
export function latestOddsRaw(fixtureId: number): unknown | null {
  const r = db().prepare("SELECT payload FROM odds_raw WHERE fixture_id = ? ORDER BY captured_at DESC LIMIT 1").get(fixtureId) as
    | { payload: string }
    | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.payload);
  } catch {
    return null;
  }
}

/* ── 每日免费场(可多场)+ kv 缓存 ── */

export function setDailyFree(date: string, fixtureId: number): void {
  db().prepare("INSERT OR IGNORE INTO free_fixtures (date, fixture_id) VALUES (?,?)").run(date, fixtureId);
}

export function freeFixtureCount(date: string): number {
  const r = db().prepare("SELECT COUNT(*) n FROM free_fixtures WHERE date = ?").get(date) as { n: number } | undefined;
  return r?.n ?? 0;
}

export function kvGet(key: string): string | null {
  const r = db().prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  return r?.v ?? null;
}
export function kvSet(key: string, value: string): void {
  db().prepare("INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
}

export interface KvCachedOptions {
  /** 空数组/null 这类“官方暂未返回”结果使用更短 TTL,避免 AF 后续补齐后前台长时间仍显示暂无。 */
  emptyTtlMs?: number;
}

function isEmptyCacheData(data: unknown): boolean {
  if (data == null) return true;
  return Array.isArray(data) && data.length === 0;
}

/** kv JSON 缓存(带 TTL),给深挖/榜单等低频端点用 */
export function kvCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>, opts: KvCachedOptions = {}): Promise<T> {
  const raw = kvGet(key);
  if (raw) {
    try {
      const { at, data } = JSON.parse(raw) as { at: number; data: T };
      const effectiveTtl = opts.emptyTtlMs != null && isEmptyCacheData(data) ? Math.min(ttlMs, opts.emptyTtlMs) : ttlMs;
      if (Date.now() - at < effectiveTtl) return Promise.resolve(data);
    } catch {
      /* 重新拉 */
    }
  }
  return fetcher().then((data) => {
    kvSet(key, JSON.stringify({ at: Date.now(), data }));
    return data;
  });
}
