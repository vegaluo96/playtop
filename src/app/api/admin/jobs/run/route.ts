import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { runJobNow } from "@/server/jobs/scheduler";

/** 手动触发定时任务（演示/补偿）：state_machine / live_revisions / fetch_results */
export async function POST(req: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const { name } = z.object({ name: z.string() }).parse(await req.json());
    const result = await runJobNow(name);
    return jsonOk(result ?? {});
  });
}
