import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { analyses, matches, outcomes } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { getConfig } from "@/server/lib/config";
import { now } from "@/server/lib/time";
import { getMatch } from "@/server/services/matchesService";
import { latestOddsBookRows, latestSnapshots, oddsSeries, snapshotStats } from "@/server/services/snapshots";
import { leagueById, teamNameById } from "@/server/services/teamResolver";

/** 单场工作台数据：比赛 + 快照 + 多书商盘口 + 最新分析（含草稿）+ 全部版本 + 赛果 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await params;
    const match = getMatch(Number(id));
    const versions = db
      .select()
      .from(analyses)
      .where(eq(analyses.matchId, match.id))
      .orderBy(desc(analyses.version))
      .all();
    const outcome = db.select().from(outcomes).where(eq(outcomes.matchId, match.id)).get() ?? null;
    const latest = versions[0] ?? null;
    return jsonOk({
      match: {
        ...match,
        league: leagueById(match.leagueId)?.name,
        homeName: teamNameById(match.homeTeamId),
        awayName: teamNameById(match.awayTeamId),
      },
      snapshots: snapshotStats(match.id),
      latestPayloads: Object.fromEntries(
        [...latestSnapshots(match.id).entries()].map(([kind, row]) => [
          kind,
          { id: row.id, source: row.source, fetchedAt: row.fetchedAt, payload: JSON.parse(row.payload) },
        ]),
      ),
      // 多书商对照：每家最新一份
      oddsBooks: latestOddsBookRows(match.id).map(({ bookmaker, row }) => ({
        bookmaker,
        source: row.source,
        fetchedAt: row.fetchedAt,
        payload: JSON.parse(row.payload),
      })),
      // 盘口异动（近 60 条，带书商）
      oddsHistory: oddsSeries(match.id)
        .slice(-60)
        .map((o) => ({ bookmaker: o.bookmaker ?? "未知来源", capturedAt: o.capturedAt, oneXTwo: o.oneXTwo ?? null })),
      // 最新分析（含草稿）：发布前即可审查引擎输出/trace/报告
      latestAnalysis: latest
        ? {
            id: latest.id,
            version: latest.version,
            status: latest.status,
            engine: JSON.parse(latest.engineOutput),
            reportMd: latest.reportMd,
          }
        : null,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        publishedAt: v.publishedAt,
        contentHash: v.contentHash,
        createdAt: v.createdAt,
      })),
      outcome,
      automation: getConfig("automation"),
    });
  });
}

const putSchema = z.object({
  kickoffAt: z.number().optional(),
  venue: z.string().optional(),
  neutral: z.boolean().optional(),
  round: z.string().optional(),
  pricePoints: z.number().int().min(0).optional(),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await params;
    const input = putSchema.parse(await req.json());
    const match = getMatch(Number(id));
    db.update(matches)
      .set({
        ...(input.kickoffAt !== undefined ? { kickoffAt: input.kickoffAt } : {}),
        ...(input.venue !== undefined ? { venue: input.venue } : {}),
        ...(input.neutral !== undefined ? { neutral: input.neutral ? 1 : 0 } : {}),
        ...(input.round !== undefined ? { round: input.round } : {}),
        ...(input.pricePoints !== undefined ? { pricePoints: input.pricePoints } : {}),
        updatedAt: now(),
      })
      .where(eq(matches.id, match.id))
      .run();
    return jsonOk({});
  });
}
