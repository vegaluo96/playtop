import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireUser } from "@/server/auth/guards";
import { unlockMatch } from "@/server/services/unlock";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const user = await requireUser();
    const { id } = await params;
    const result = unlockMatch(user.id, Number(id));
    return jsonOk(result);
  });
}
