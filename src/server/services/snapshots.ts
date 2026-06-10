import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { dataSnapshots, SNAPSHOT_KINDS, type SnapshotKind } from "../db/schema";
import { PAYLOAD_SCHEMAS, type PayloadKind } from "../datasources/types";
import { normalizedOddsSchema, type NormalizedOdds } from "../engine/types";
import { hashObject } from "../lib/hash";
import { now } from "../lib/time";

export type SnapshotSource = "football_data_couk" | "open_meteo" | "local_stats" | "llm" | "manual" | "sporttery";

/**
 * 快照写入唯一入口：zod 归一校验 + 内容哈希；与该 kind 最新一份内容相同则不重复入库。
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
  const contentHash = hashObject(parsed);
  const latest = db
    .select()
    .from(dataSnapshots)
    .where(and(eq(dataSnapshots.matchId, matchId), eq(dataSnapshots.kind, kind)))
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
  manual_override: "手动覆盖",
};

export interface SnapshotStats {
  perKind: { kind: SnapshotKind; kindLabel: string; source: string; fetchedAt: number; count: number }[];
  missing: SnapshotKind[];
  total: number;
}

export function snapshotStats(matchId: number): SnapshotStats {
  const rows = db
    .select()
    .from(dataSnapshots)
    .where(eq(dataSnapshots.matchId, matchId))
    .orderBy(asc(dataSnapshots.fetchedAt))
    .all();
  const byKind = new Map<SnapshotKind, { source: string; fetchedAt: number; count: number }>();
  for (const r of rows) {
    const cur = byKind.get(r.kind);
    byKind.set(r.kind, { source: r.source, fetchedAt: r.fetchedAt, count: (cur?.count ?? 0) + 1 });
  }
  const expected = SNAPSHOT_KINDS.filter((k) => k !== "manual_override");
  return {
    perKind: [...byKind.entries()].map(([kind, v]) => ({
      kind,
      kindLabel: KIND_LABELS[kind],
      ...v,
    })),
    missing: expected.filter((k) => !byKind.has(k)),
    total: rows.length,
  };
}
