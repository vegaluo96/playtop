import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { publishAnalysisRow } from "@/server/services/publish";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { pricePoints } = z.object({ pricePoints: z.number().int().min(0).optional() }).parse(body);
    publishAnalysisRow(Number(id), { adminId: admin.id, pricePoints });
    return jsonOk({});
  });
}
