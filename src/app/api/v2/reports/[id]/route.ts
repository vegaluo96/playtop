import { handleRoute, jsonOk, HttpError } from "@/server/lib/api";
import { currentUser } from "@/server/auth/guards";
import { hasUnlocked } from "@/server/services/unlock";
import { v2ReportVersion } from "@/server/v2/read";

/** V2：研报版本（门控同 matches/[id]） */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const report = v2ReportVersion(Number(id));
    if (!report) throw new HttpError(404, "研报版本不存在");
    const user = await currentUser();
    const canRead = report.isPublic === 1 || user?.role === "admin" || (user ? hasUnlocked(user.id, report.matchId) : false);
    return jsonOk({
      id: report.id,
      matchId: report.matchId,
      versionType: report.versionType,
      title: report.title,
      freePreview: JSON.parse(report.freePreview),
      paidContent: canRead ? report.paidContent : null,
      reportHash: report.reportHash,
      previousReportHash: report.previousReportHash,
      isPublic: report.isPublic === 1,
      createdAt: report.createdAt,
    });
  });
}
