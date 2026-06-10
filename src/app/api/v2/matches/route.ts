import { handleRoute, jsonOk } from "@/server/lib/api";
import { v2ListMatches } from "@/server/v2/read";

/** V2：比赛列表（V2 状态语义 + 最新研报版本 + 锁定/结算标记） */
export async function GET() {
  return handleRoute(async () => jsonOk(v2ListMatches(200)));
}
