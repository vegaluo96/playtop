import { desc, like } from "drizzle-orm";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireAdmin } from "@/server/auth/guards";

export async function GET(req: Request) {
  return handleRoute(async () => {
    await requireAdmin();
    const q = new URL(req.url).searchParams.get("q")?.trim();
    const rows = q
      ? db.select().from(users).where(like(users.username, `%${q}%`)).orderBy(desc(users.createdAt)).limit(100).all()
      : db.select().from(users).orderBy(desc(users.createdAt)).limit(100).all();
    return jsonOk(rows.map(({ passwordHash, ...rest }) => { void passwordHash; return rest; }));
  });
}
