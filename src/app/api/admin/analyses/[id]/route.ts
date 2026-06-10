import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { analyses } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { HttpError } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";
import { updateDraftSections } from "@/server/services/publish";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await requireAdmin();
    const { id } = await params;
    const row = db.select().from(analyses).where(eq(analyses.id, Number(id))).get();
    if (!row) throw new HttpError(404, "分析不存在");
    return jsonOk({
      ...row,
      engineOutput: JSON.parse(row.engineOutput),
      llmSections: row.llmSections ? JSON.parse(row.llmSections) : null,
    });
  });
}

const putSchema = z.object({
  thesis: z.string().min(1).optional(),
  drivers: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
});

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    const { id } = await params;
    const input = putSchema.parse(await req.json());
    updateDraftSections(Number(id), input, admin.id);
    return jsonOk({});
  });
}
