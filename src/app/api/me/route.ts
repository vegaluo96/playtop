import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { pointTransactions, unlocks } from "@/server/db/schema";
import { handleRoute, jsonOk } from "@/server/lib/api";
import { requireUser } from "@/server/auth/guards";

export async function GET() {
  return handleRoute(async () => {
    const user = await requireUser();
    const transactions = db
      .select()
      .from(pointTransactions)
      .where(eq(pointTransactions.userId, user.id))
      .orderBy(desc(pointTransactions.createdAt))
      .limit(100)
      .all();
    const unlockRows = db
      .select()
      .from(unlocks)
      .where(eq(unlocks.userId, user.id))
      .orderBy(desc(unlocks.createdAt))
      .all();
    return jsonOk({
      id: user.id,
      username: user.username,
      role: user.role,
      points: user.points,
      transactions,
      unlocks: unlockRows,
    });
  });
}
