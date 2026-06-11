/**
 * 数据层落库:赛程缓存、odds/predictions 快照归档(AF 赛前 odds 仅 1–14 天窗口,
 * 必须平台自有库持续归档)、相邻快照 diff 生成「异动」、模型战绩结算。
 */
import { db, tx } from "../db";
import { detectMovement, normalizeOddsItem } from "./normalize";
import { isFinished } from "./schedule";

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
/** 主源书商优先级(列表/走势的「主盘」取第一个有数据的) */
export const PRIMARY_BOOKMAKERS = ["Bet365", "平博", "马拉松", "Bwin", "1xBet", "必发"];

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
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
         payload=CASE WHEN length(excluded.payload) >= length(fixtures_cache.payload) THEN excluded.payload ELSE fixtures_cache.payload END,
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
      JSON.stringify(item),
      Date.now(),
    );
  return id;
}

export function fixtureById(id: number): FixtureRow | null {
  return (db().prepare("SELECT * FROM fixtures_cache WHERE fixture_id = ?").get(id) as FixtureRow | undefined) ?? null;
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

/**
 * 归档一次 /odds 拉取:原始 payload 落 odds_raw,归一化落 odds_snapshots,
 * 与同书商同市场上一帧 diff → movements。返回新增异动数。
 */
export function archiveOdds(fixtureId: number, oddsItem: unknown, capturedAt = Date.now()): number {
  const books = normalizeOddsItem(oddsItem);
  if (books.length === 0) return 0;
  return tx(() => {
    const d = db();
    d.prepare("INSERT INTO odds_raw (fixture_id, payload, captured_at) VALUES (?,?,?)").run(
      fixtureId, JSON.stringify(oddsItem), capturedAt,
    );
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
 * 某场某市场的快照序列:按实际抓取情况选源——取该市场「最新一帧最新鲜」的书商
 * (同鲜度按 PRIMARY 顺序),不强制全场同源;全部书商数据都在,百家对比可查任一家。
 */
export function oddsSeries(fixtureId: number, market: "ah" | "ou" | "eu"): SnapRow[] {
  const d = db();
  const latest = d
    .prepare(
      "SELECT bookmaker, MAX(captured_at) at FROM odds_snapshots WHERE fixture_id = ? AND market = ? GROUP BY bookmaker",
    )
    .all(fixtureId, market) as unknown as { bookmaker: string; at: number }[];
  if (latest.length === 0) return [];
  const rank = (n: string) => {
    const i = PRIMARY_BOOKMAKERS.indexOf(n);
    return i < 0 ? 99 : i;
  };
  latest.sort((x, y) => y.at - x.at || rank(x.bookmaker) - rank(y.bookmaker));
  const pick = latest[0].bookmaker;
  return d
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? AND bookmaker = ? ORDER BY captured_at")
    .all(fixtureId, market, pick) as unknown as SnapRow[];
}

/** 各书商归档首帧/即时盘(百家对比) */
export function oddsCompare(fixtureId: number, market: "ah" | "ou" | "eu"): { bookmaker: string; first: SnapRow; last: SnapRow }[] {
  const d = db();
  const rows = d
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? ORDER BY captured_at")
    .all(fixtureId, market) as unknown as SnapRow[];
  const byBook = new Map<string, SnapRow[]>();
  for (const r of rows) {
    if (!byBook.has(r.bookmaker)) byBook.set(r.bookmaker, []);
    byBook.get(r.bookmaker)!.push(r);
  }
  const order = (n: string) => {
    const i = PRIMARY_BOOKMAKERS.indexOf(n);
    return i < 0 ? 99 : i;
  };
  return [...byBook.entries()]
    .sort((x, y) => order(x[0]) - order(y[0]))
    .map(([bookmaker, list]) => ({ bookmaker, first: list[0], last: list[list.length - 1] }));
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
  const where = type === "滚球" ? "WHERE m.phase = ?" : type && type !== "全部" ? "WHERE m.type = ?" : "";
  const args: unknown[] = type && type !== "全部" ? [type, limit] : [limit];
  return db()
    .prepare(
      `SELECT m.*, f.home_name, f.away_name, f.league_name, f.league_id
       FROM movements m JOIN fixtures_cache f ON f.fixture_id = m.fixture_id
       ${where} ORDER BY m.t1 DESC LIMIT ?`,
    )
    .all(...(args as [string, number] | [number])) as unknown as (MovementRow & { home_name: string; away_name: string; league_name: string; league_id: number })[];
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
  if (!r) return null;
  try {
    return JSON.parse(r.payload);
  } catch {
    return null;
  }
}

export function hasPrediction(fixtureId: number): boolean {
  return !!db().prepare("SELECT 1 FROM predictions_snapshots WHERE fixture_id = ? LIMIT 1").get(fixtureId);
}

/* ── 模型战绩(预测对照赛果自动统计)── */

/** 完场结算:用最近一帧预测快照的 winner/percent 对照终局比分 */
export function settleFixture(fx: FixtureRow): void {
  if (!isFinished(fx.status) || fx.goals_home == null || fx.goals_away == null) return;
  const d = db();
  if (d.prepare("SELECT 1 FROM model_records WHERE fixture_id = ?").get(fx.fixture_id)) return;
  const pred = latestPrediction(fx.fixture_id) as Record<string, unknown> | null;
  if (!pred) return;
  const p = (Array.isArray(pred) ? pred[0] : pred) as Record<string, unknown>;
  const winnerId = Number(dig(p, "predictions", "winner", "id")) || null;
  const winDraw = Boolean(dig(p, "predictions", "win_or_draw"));
  if (!winnerId) return;
  const pickedHome = winnerId === fx.home_id;
  const pick = (pickedHome ? fx.home_name : fx.away_name) + (winDraw ? "(双重机会)" : "胜");
  const diff = fx.goals_home - fx.goals_away;
  const hit = pickedHome
    ? winDraw
      ? diff >= 0
      : diff > 0
    : winDraw
      ? diff <= 0
      : diff < 0;
  const date = new Date(fx.kickoff_utc + 8 * 3_600_000).toISOString().slice(0, 10); // 平台运营时区 UTC+8
  d.prepare(
    "INSERT INTO model_records (fixture_id, date, match_name, pick, score, hit, settled_at) VALUES (?,?,?,?,?,?,?)",
  ).run(fx.fixture_id, date, `${fx.home_name} vs ${fx.away_name}`, pick, `${fx.goals_home}-${fx.goals_away}`, hit ? 1 : 0, Date.now());
}

export interface ModelStats {
  hitRate30: number | null;
  yesterday: { hit: number; total: number };
  streak: number;
  week: { date: string; hit: number; total: number }[];
  yesterdayRows: { match: string; pick: string; score: string; hit: number }[];
}

export function modelStats(nowMs = Date.now()): ModelStats {
  const d = db();
  const day = (offset: number) => new Date(nowMs + 8 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);
  const since30 = day(30);
  const all30 = d
    .prepare("SELECT hit FROM model_records WHERE date >= ? AND hit IS NOT NULL ORDER BY settled_at")
    .all(since30) as { hit: number }[];
  const hitRate30 = all30.length > 0 ? Math.round((all30.filter((r) => r.hit).length / all30.length) * 1000) / 10 : null;
  const yRows = d
    .prepare("SELECT match_name, pick, score, hit FROM model_records WHERE date = ? AND hit IS NOT NULL")
    .all(day(1)) as { match_name: string; pick: string; score: string; hit: number }[];
  let streak = 0;
  for (let i = all30.length - 1; i >= 0 && all30[i].hit; i--) streak++;
  const week = Array.from({ length: 7 }, (_, i) => {
    const dt = day(6 - i);
    const rows = d.prepare("SELECT hit FROM model_records WHERE date = ? AND hit IS NOT NULL").all(dt) as { hit: number }[];
    return { date: dt, hit: rows.filter((r) => r.hit).length, total: rows.length };
  });
  return {
    hitRate30,
    yesterday: { hit: yRows.filter((r) => r.hit).length, total: yRows.length },
    streak,
    week,
    yesterdayRows: yRows.map((r) => ({ match: r.match_name, pick: r.pick, score: r.score, hit: r.hit })),
  };
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

/** kv JSON 缓存(带 TTL),给深挖/榜单等低频端点用 */
export function kvCached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const raw = kvGet(key);
  if (raw) {
    try {
      const { at, data } = JSON.parse(raw) as { at: number; data: T };
      if (Date.now() - at < ttlMs) return Promise.resolve(data);
    } catch {
      /* 重新拉 */
    }
  }
  return fetcher().then((data) => {
    kvSet(key, JSON.stringify({ at: Date.now(), data }));
    return data;
  });
}
