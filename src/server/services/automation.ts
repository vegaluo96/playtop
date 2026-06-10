import { getConfig } from "../lib/config";
import { analyzeMatch, latestAnalysis } from "./analyze";
import { logAudit } from "./audit";
import { collectMatch } from "./collect";
import { getMatch } from "./matchesService";
import { publishAnalysisRow } from "./publish";

/**
 * 全自动流水线编排器：按当前状态把比赛往前推一步到位。
 * 调度器（每 30 分钟）与工作台「立即推进」按钮共用同一实现。
 * (采集 →) 建模 → 按默认价发布首版 → 改版重算（变了自动发新版）。
 * 各步独立容错（与并发的定时任务竞态时跳过而非报错）；automation 开关控制各步，关掉即回退人工。
 */
export async function advanceMatch(
  matchId: number,
  opts: { collect?: boolean } = {},
): Promise<string[]> {
  const auto = getConfig("automation");
  const steps: string[] = [];
  let match = getMatch(matchId);

  // 采集步：仅手动「立即推进」触发（调度器在调用前已自行采集，避免双倍 AI 成本）
  if (opts.collect && (match.status === "scheduled" || match.status === "collecting")) {
    try {
      const r = await collectMatch(matchId, {});
      steps.push(`采集完成：${r.collected.length} 个维度成功${r.failed.length ? `，${r.failed.length} 个失败` : ""}`);
    } catch (e) {
      steps.push(`采集失败：${e instanceof Error ? e.message : e}`);
    }
    match = getMatch(matchId);
  }

  if (match.status === "ready" && auto.autoAnalyze) {
    try {
      const r = await analyzeMatch(matchId);
      steps.push(r.changed ? `自动建模：生成 V${r.version} 草稿` : "自动建模：输出与上版一致，未产生新版本");
    } catch (e) {
      steps.push(`建模失败：${e instanceof Error ? e.message : e}`);
    }
    match = getMatch(matchId);
  }

  if (match.status === "analyzed" && auto.autoPublish) {
    const latest = latestAnalysis(matchId);
    if (latest && latest.status === "draft") {
      try {
        publishAnalysisRow(latest.id, {}); // 无管理员、默认积分价（publish.ts 原生支持）
        logAudit({ actorId: 0, action: "auto_publish", entity: "analysis", entityId: latest.id });
        steps.push(`自动发布：V${latest.version} 已按默认价上线`);
      } catch (e) {
        // 与定时任务竞态（草稿已被发布）等情况：跳过即可
        steps.push(`发布步跳过：${e instanceof Error ? e.message : e}`);
      }
      match = getMatch(matchId);
    }
  }

  if (match.status === "published") {
    try {
      const r = await analyzeMatch(matchId, { autoPublishRevision: true });
      if (r.changed) steps.push(`实时改版：数据变化触发 V${r.version}${r.autoPublished ? "（已自动发布）" : ""}`);
    } catch (e) {
      steps.push(`改版重算失败：${e instanceof Error ? e.message : e}`);
    }
  }

  return steps;
}
