import { getConfig } from "../lib/config";
import { analyzeMatch, latestAnalysis } from "./analyze";
import { logAudit } from "./audit";
import { getMatch } from "./matchesService";
import { publishAnalysisRow } from "./publish";

/**
 * 全自动流水线编排器：按当前状态把比赛往前推一步到位。
 * 调度器（每 30 分钟）与工作台「立即推进」按钮共用同一实现。
 * ready → 建模；analyzed(有草稿) → 按默认价发布首版；published → 改版重算（变了自动发新版）。
 * 各步受 automation 配置开关控制，关掉即回退人工流程。
 */
export async function advanceMatch(matchId: number): Promise<string[]> {
  const auto = getConfig("automation");
  const steps: string[] = [];
  let match = getMatch(matchId);

  if (match.status === "ready" && auto.autoAnalyze) {
    const r = await analyzeMatch(matchId);
    steps.push(r.changed ? `自动建模：生成 V${r.version} 草稿` : "自动建模：输出与上版一致，未产生新版本");
    match = getMatch(matchId);
  }

  if (match.status === "analyzed" && auto.autoPublish) {
    const latest = latestAnalysis(matchId);
    if (latest && latest.status === "draft") {
      publishAnalysisRow(latest.id, {}); // 无管理员、默认积分价（publish.ts 原生支持）
      logAudit({ actorId: 0, action: "auto_publish", entity: "analysis", entityId: latest.id });
      steps.push(`自动发布：V${latest.version} 已按默认价上线`);
      match = getMatch(matchId);
    }
  }

  if (match.status === "published") {
    const r = await analyzeMatch(matchId, { autoPublishRevision: true });
    if (r.changed) steps.push(`实时改版：数据变化触发 V${r.version}${r.autoPublished ? "（已自动发布）" : ""}`);
  }

  return steps;
}
