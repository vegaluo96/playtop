import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { dataSnapshots, SNAPSHOT_KINDS, type SnapshotKind } from "../db/schema";
import { PAYLOAD_SCHEMAS, type PayloadKind } from "../datasources/types";
import { normalizedOddsSchema, type NormalizedOdds } from "../engine/types";
import { hashObject } from "../lib/hash";
import { now } from "../lib/time";

export type SnapshotSource =
  | "football_data_couk"
  | "open_meteo"
  | "local_stats"
  | "llm"
  | "manual"
  | "sporttery"
  | "polymarket"
  | "espn"
  | "github"
  | "clubelo"
  | "eloratings"
  | "manifold"
  | "smarkets"
  | "understat"
  | "api_football";

/**
 * 快照写入唯一入口：zod 归一校验 + 内容哈希；与该 kind 最新一份内容相同则不重复入库。
 * odds 特殊处理：哈希剔除 capturedAt（否则时间戳每次不同、去重永不生效），
 * 且按 bookmaker 维度独立去重——多家书商并存互不覆盖。
 * 快照表只插不改不删——这是审计与"实时改版"机制的地基。
 */
export function insertSnapshot(
  matchId: number,
  kind: SnapshotKind,
  source: SnapshotSource,
  payload: unknown,
): { id: number; changed: boolean } {
  const schema = PAYLOAD_SCHEMAS[kind as PayloadKind];
  const parsed = schema.parse(payload);
  const isOdds = kind === "odds";
  const contentHash = isOdds
    ? hashObject({ ...(parsed as Record<string, unknown>), capturedAt: 0 })
    : hashObject(parsed);
  const bookmaker = isOdds ? ((parsed as { bookmaker?: string }).bookmaker ?? source) : null;
  const latest = db
    .select()
    .from(dataSnapshots)
    .where(
      and(
        eq(dataSnapshots.matchId, matchId),
        eq(dataSnapshots.kind, kind),
        ...(isOdds ? [sql`json_extract(${dataSnapshots.payload}, '$.bookmaker') = ${bookmaker}`] : []),
      ),
    )
    .orderBy(desc(dataSnapshots.fetchedAt), desc(dataSnapshots.id))
    .limit(1)
    .get();
  if (latest && latest.contentHash === contentHash) {
    return { id: latest.id, changed: false };
  }
  const inserted = db
    .insert(dataSnapshots)
    .values({
      matchId,
      kind,
      source,
      payload: JSON.stringify(parsed),
      contentHash,
      fetchedAt: now(),
    })
    .returning({ id: dataSnapshots.id })
    .get();
  return { id: inserted.id, changed: true };
}

export type SnapshotRow = typeof dataSnapshots.$inferSelect;

/** 每 kind 最新一份 */
export function latestSnapshots(matchId: number): Map<SnapshotKind, SnapshotRow> {
  const rows = db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.matchId, matchId))
    .orderBy(asc(dataSnapshots.fetchedAt), asc(dataSnapshots.id))
    .all();
  const map = new Map<SnapshotKind, SnapshotRow>();
  for (const r of rows) map.set(r.kind, r); // 升序遍历，后者覆盖 → 最新
  return map;
}

export function snapshotPayload<T>(row: SnapshotRow | undefined): T | null {
  if (!row) return null;
  return JSON.parse(row.payload) as T;
}

/** 盘口异动序列（odds kind 全部快照，升序） */
export function oddsSeries(matchId: number): NormalizedOdds[] {
  const rows = db
    .select()
    .from(dataSnapshots)
    .where(and(eq(dataSnapshots.matchId, matchId), eq(dataSnapshots.kind, "odds")))
    .orderBy(asc(dataSnapshots.fetchedAt), asc(dataSnapshots.id))
    .all();
  return rows.map((r) => normalizedOddsSchema.parse(JSON.parse(r.payload)));
}

/**
 * 盘口一致性窗口：某家书商的"最新"快照若比全场最新一份旧 6 小时以上，
 * 或绝对年龄超过 48 小时，视为停更死源残留——剔出引擎/最优价/收盘/展示口径。
 * 否则已退役源的旧价会与临场新价同台：污染共识与 EV、把"停更"误报成"让利"。
 * 静默期（全场盘口同批采集）天然同窗，不受影响。
 */
const BOOK_COHERENCE_MS = 6 * 3_600_000;
const BOOK_ABSOLUTE_STALE_MS = 48 * 3_600_000;

/** 每家书商各自最新的一份 odds 快照（按书商名排序保证确定性；含一致性窗口过滤） */
export function latestOddsBookRows(matchId: number): { bookmaker: string; row: SnapshotRow }[] {
  const rows = db
    .select()
    .from(dataSnapshots)
    .where(and(eq(dataSnapshots.matchId, matchId), eq(dataSnapshots.kind, "odds")))
    .orderBy(asc(dataSnapshots.fetchedAt), asc(dataSnapshots.id))
    .all();
  const map = new Map<string, SnapshotRow>();
  for (const r of rows) {
    const bm = (JSON.parse(r.payload) as { bookmaker?: string }).bookmaker ?? r.source;
    map.set(bm, r); // 升序遍历，后者覆盖 → 每家最新
  }
  const entries = [...map.entries()];
  const newest = Math.max(...entries.map(([, row]) => row.fetchedAt), 0);
  return entries
    .filter(([, row]) => newest - row.fetchedAt <= BOOK_COHERENCE_MS && now() - row.fetchedAt <= BOOK_ABSOLUTE_STALE_MS)
    .map(([bookmaker, row]) => ({ bookmaker, row }))
    .sort((a, b) => a.bookmaker.localeCompare(b.bookmaker));
}

/** 引擎输入用：每家最新盘口的归一化 payload 列表 */
export function latestOddsBooks(matchId: number): NormalizedOdds[] {
  return latestOddsBookRows(matchId).map(({ row }) => normalizedOddsSchema.parse(JSON.parse(row.payload)));
}

export const KIND_LABELS: Record<SnapshotKind, string> = {
  odds: "盘口赔率",
  injuries: "伤停",
  suspensions: "停赛",
  lineups: "预计阵容",
  h2h: "历史交锋",
  form: "近期状态",
  team_stats: "赛季数据",
  standings: "积分榜",
  player_stats: "球员数据",
  coach: "教练",
  venue: "场馆",
  weather: "天气",
  referee: "裁判",
  soft_info: "软信息",
  external_ratings: "外部评级",
  manual_override: "手动覆盖",
};

export interface SnapshotStats {
  perKind: { kind: SnapshotKind; kindLabel: string; source: string; fetchedAt: number; count: number }[];
  missing: SnapshotKind[];
  total: number;
}

function statsFromRows(rows: SnapshotRow[]): SnapshotStats {
  const byKind = new Map<SnapshotKind, { source: string; fetchedAt: number; count: number }>();
  for (const r of rows) {
    const cur = byKind.get(r.kind);
    byKind.set(r.kind, { source: r.source, fetchedAt: r.fetchedAt, count: (cur?.count ?? 0) + 1 });
  }
  const expected = SNAPSHOT_KINDS.filter((k) => k !== "manual_override");
  return {
    perKind: [...byKind.entries()].map(([kind, v]) => ({ kind, kindLabel: KIND_LABELS[kind], ...v })),
    missing: expected.filter((k) => !byKind.has(k)),
    total: rows.length,
  };
}

export function snapshotStats(matchId: number): SnapshotStats {
  const rows = db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.matchId, matchId))
    .orderBy(asc(dataSnapshots.fetchedAt))
    .all();
  return statsFromRows(rows);
}

/** 一次查询同时得出"完备度统计"与"每 kind 最新一份"——比赛详情页用，避免双倍全表扫描 */
export function snapshotBundle(matchId: number): { stats: SnapshotStats; latest: Map<SnapshotKind, SnapshotRow> } {
  const rows = db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.matchId, matchId))
    .orderBy(asc(dataSnapshots.fetchedAt), asc(dataSnapshots.id))
    .all();
  const latest = new Map<SnapshotKind, SnapshotRow>();
  for (const r of rows) latest.set(r.kind, r); // 升序遍历，后者覆盖 → 最新
  return { stats: statsFromRows(rows), latest };
}
