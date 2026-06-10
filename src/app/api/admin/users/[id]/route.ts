import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { logAudit } from "@/server/services/audit";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const { status } = z.object({ status: z.enum(["active", "banned"]) }).parse(await req.json());
    db.update(users).set({ status }).where(eq(users.id, Number(id))).run();
    logAudit({ actorId: admin.id, action: "set_user_status", entity: "user", entityId: Number(id), detail: { status } });
    return jsonOk({});
  });
}
