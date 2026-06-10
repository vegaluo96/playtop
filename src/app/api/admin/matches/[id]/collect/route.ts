import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { collectMatch } from "@/server/services/collect";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const result = await collectMatch(Number(id), { force: true, skipAi: body?.skipAi === true });
    return jsonOk(result);
  });
}
