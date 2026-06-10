import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { leagues, teams } from "../db/schema";
import { now } from "../lib/time";

/** 联赛代码 → 中文名（football-data.co.uk 常用代码 + 国际赛） */
export const LEAGUE_NAMES: Record<string, { name: string; country: string }> = {
  E0: { name: "英超", country: "英格兰" },
  E1: { name: "英冠", country: "英格兰" },
  SP1: { name: "西甲", country: "西班牙" },
  SP2: { name: "西乙", country: "西班牙" },
  I1: { name: "意甲", country: "意大利" },
  I2: { name: "意乙", country: "意大利" },
  D1: { name: "德甲", country: "德国" },
  D2: { name: "德乙", country: "德国" },
  F1: { name: "法甲", country: "法国" },
  F2: { name: "法乙", country: "法国" },
  N1: { name: "荷甲", country: "荷兰" },
  B1: { name: "比甲", country: "比利时" },
  P1: { name: "葡超", country: "葡萄牙" },
  T1: { name: "土超", country: "土耳其" },
  G1: { name: "希超", country: "希腊" },
  SC0: { name: "苏超", country: "苏格兰" },
  INT: { name: "国际赛事", country: "国际" },
  WC2026: { name: "世界杯 2026", country: "国际" },
};

export function ensureLeague(code: string): number {
  const existing = db.select().from(leagues).where(eq(leagues.code, code)).get();
  if (existing) return existing.id;
  const meta = LEAGUE_NAMES[code] ?? { name: code, country: "" };
  const inserted = db
    .insert(leagues)
    .values({ code, name: meta.name, country: meta.country, createdAt: now() })
    .returning({ id: leagues.id })
    .get();
  return inserted.id;
}

/**
 * 队名归一：按 (country, name) 或别名匹配；找不到则创建。
 * CSV 队名（如 "Man United"）通过 aliases 累积映射，保证多源数据指向同一支队。
 */
export function resolveTeam(name: string, country: string | null): number {
  const trimmed = name.trim();
  const candidates = country
    ? db.select().from(teams).where(eq(teams.country, country)).all()
    : db.select().from(teams).where(isNull(teams.country)).all();
  for (const t of candidates) {
    if (t.name === trimmed) return t.id;
    const aliases = JSON.parse(t.aliases) as string[];
    if (aliases.includes(trimmed)) return t.id;
  }
  // 全库别名兜底（避免 country 标注不一致造成重复建队）
  const all = db.select().from(teams).all();
  for (const t of all) {
    if (t.name === trimmed) return t.id;
    const aliases = JSON.parse(t.aliases) as string[];
    if (aliases.includes(trimmed)) return t.id;
  }
  const inserted = db
    .insert(teams)
    .values({ name: trimmed, country, aliases: "[]", createdAt: now() })
    .returning({ id: teams.id })
    .get();
  return inserted.id;
}

export function addTeamAlias(teamId: number, alias: string): void {
  const t = db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!t) return;
  const aliases = JSON.parse(t.aliases) as string[];
  if (!aliases.includes(alias) && t.name !== alias) {
    aliases.push(alias);
    db.update(teams).set({ aliases: JSON.stringify(aliases) }).where(eq(teams.id, teamId)).run();
  }
}

export function teamNameById(teamId: number): string {
  return db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).get()?.name ?? `#${teamId}`;
}

export function leagueById(leagueId: number) {
  return db.select().from(leagues).where(eq(leagues.id, leagueId)).get() ?? null;
}
