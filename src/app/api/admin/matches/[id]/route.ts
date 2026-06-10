import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { analyses, matches, outcomes } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { now } from "@/server/lib/time";
import { getMatch } from "@/server/services/matchesService";
import { latestSnapshots, snapshotStats } from "@/server/services/snapshots";
import { leagueById, teamNameById } from "@/server/services/teamResolver";

/** 单场工作台数据：比赛 + 快照 + 全部版本 + 赛果 */
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
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        publishedAt: v.publishedAt,
        contentHash: v.contentHash,
        createdAt: v.createdAt,
      })),
      outcome,
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
