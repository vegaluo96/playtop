import { z } from "zod";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { adminAdjustPoints } from "@/server/services/points";

/** 唯一的积分进入渠道：管理员手动加/减（产品无自助充值） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const { delta, note } = z
      .object({ delta: z.number().int(), note: z.string().optional() })
      .parse(await req.json());
    const result = adminAdjustPoints({ adminId: admin.id, userId: Number(id), delta, note });
    return jsonOk(result);
  });
}
