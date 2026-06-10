import { handleRoute, jsonOk, HttpError } from "@/server/lib/api";
import { v2AuditChain } from "@/server/v2/read";

/** V2：公开审计链（无需登录）——快照/模型运行/版本/锁定/结算全链哈希与校验结果 */
export async function GET(_req: Request, { params }: { params: Promise<{ matchId: string }> }) {
  return handleRoute(async () => {
    const { matchId } = await params;
    const chain = v2AuditChain(Number(matchId));
    if (!chain) throw new HttpError(404, "比赛不存在");
    return jsonOk(chain);
  });
}
