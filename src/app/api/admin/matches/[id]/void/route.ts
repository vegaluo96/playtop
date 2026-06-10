import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { voidMatch } from "@/server/services/publish";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const { reason } = z.object({ reason: z.string().min(1) }).parse(await req.json());
    voidMatch(Number(id), reason, admin.id);
    return jsonOk({});
  });
}
