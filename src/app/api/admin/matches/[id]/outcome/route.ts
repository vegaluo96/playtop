import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { confirmOutcome, recordOutcome, settleDueMatches } from "@/server/services/settle";

const inputSchema = z.union([
  z.object({
    action: z.literal("record"),
    homeGoals: z.number().int().min(0).max(20),
    awayGoals: z.number().int().min(0).max(20),
    htHome: z.number().int().min(0).max(20).nullable().optional(),
    htAway: z.number().int().min(0).max(20).nullable().optional(),
    finalStatus: z.enum(["finished", "abandoned", "postponed"]).default("finished"),
  }),
  z.object({ action: z.literal("confirm") }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const input = inputSchema.parse(await req.json());
    if (input.action === "record") {
      recordOutcome({
        matchId: Number(id),
        homeGoals: input.homeGoals,
        awayGoals: input.awayGoals,
        htHome: input.htHome ?? null,
        htAway: input.htAway ?? null,
        finalStatus: input.finalStatus,
        source: "manual",
        provisional: false,
        recordedBy: admin.id,
      });
    } else {
      confirmOutcome(Number(id), admin.id);
    }
    // 录入后立即尝试结算（无需等 cron）
    const settled = settleDueMatches();
    return jsonOk({ settled });
  });
}
