import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/server/db";
import { leagues, matches, teams } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { createManualMatch } from "@/server/services/matchesService";
import { logAudit } from "@/server/services/audit";

export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    const home = alias(teams, "home_team");
    const away = alias(teams, "away_team");
    const rows = db
      .select({ m: matches, league: leagues.name, homeName: home.name, awayName: away.name })
      .from(matches)
      .innerJoin(leagues, eq(leagues.id, matches.leagueId))
      .innerJoin(home, eq(home.id, matches.homeTeamId))
      .innerJoin(away, eq(away.id, matches.awayTeamId))
      .orderBy(desc(matches.kickoffAt))
      .limit(300)
      .all();
    return jsonOk(rows.map((r) => ({ ...r.m, league: r.league, homeName: r.homeName, awayName: r.awayName })));
  });
}

const createSchema = z.object({
  leagueCode: z.string().min(1),
  homeName: z.string().min(1),
  awayName: z.string().min(1),
  kickoffAt: z.number(),
  venue: z.string().optional(),
  neutral: z.boolean().optional(),
  round: z.string().optional(),
  country: z.string().optional(),
});

export async function POST(req: Request) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const input = createSchema.parse(await req.json());
    const id = createManualMatch(input);
    logAudit({ actorId: admin.id, action: "create_match", entity: "match", entityId: id, detail: input });
    return jsonOk({ id });
  });
}
