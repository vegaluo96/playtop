import { handleRoute, jsonOk, HttpError } from "@/server/lib/api";
import { currentUser } from "@/server/auth/guards";
import { hasUnlocked } from "@/server/services/unlock";
import { v2LatestReportForMatch, v2ListMatches } from "@/server/v2/read";

/** V2：单场详情（付费正文按解锁/公开门控） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const match = v2ListMatches(10000).find((m) => m.id === Number(id));
    if (!match) throw new HttpError(404, "比赛不存在");
    const report = v2LatestReportForMatch(match.id);
    const user = await currentUser();
    const canRead =
      !!report && (report.isPublic === 1 || user?.role === "admin" || (user ? hasUnlocked(user.id, match.id) : false));
    return jsonOk({
      match,
      report: report
        ? {
            id: report.id,
            versionType: report.versionType,
            title: report.title,
            freePreview: JSON.parse(report.freePreview),
            paidContent: canRead ? report.paidContent : null,
            summary: canRead ? JSON.parse(report.summaryJson) : null,
            reportHash: report.reportHash,
            isPublic: report.isPublic === 1,
            createdAt: report.createdAt,
          }
        : null,
    });
  });
}
