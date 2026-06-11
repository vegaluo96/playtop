import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { analyses, matches, predictions } from "../db/schema";
import { HttpError } from "../lib/api";
import { getConfig } from "../lib/config";
import { hashObject } from "../lib/hash";
import { now } from "../lib/time";
import { logAudit } from "./audit";
import { refundMatchUnlocks } from "./unlock";

/**
 * 发布与哈希链：每个发布版本（含自动改版）都进入全局 hash 链——
 * contentHash = H(matchId, version, engineOutput, reportMd, llmSections)，
 * prevHash 指向上一份已发布报告。篡改/删除任何历史版本都会断链，/verify 公开可验。
 */

function chainHead(): string | null {
  const row = db
    .select({ contentHash: analyses.contentHash })
    .from(analyses)
    .where(isNotNull(analyses.publishedAt))
    .orderBy(desc(analyses.publishedAt), desc(analyses.id))
    .limit(1)
    .get();
  return row?.contentHash ?? null;
}

export function computeAnalysisHash(row: {
  matchId: number;
  version: number;
  engineOutput: string;
  reportMd: string;
  llmSections: string | null;
}): string {
  return hashObject({
    matchId: row.matchId,
    version: row.version,
    engineOutput: row.engineOutput,
    reportMd: row.reportMd,
    llmSections: row.llmSections,
  });
}

/** 发布一份分析（首版手动发布 / 改版自动发布共用） */
export function publishAnalysisRow(
  analysisId: number,
  opts: { adminId?: number; pricePoints?: number },
): void {
  db.transaction((tx) => {
    const row = tx.select().from(analyses).where(eq(analyses.id, analysisId)).get();
    if (!row) throw new HttpError(404, "分析不存在");
    if (row.status !== "draft") throw new HttpError(400, "只有草稿可以发布");
    const match = tx.select().from(matches).where(eq(matches.id, row.matchId)).get();
    if (!match) throw new HttpError(404, "比赛不存在");
    // 赛前任意状态都可发布（草稿存在即代表引擎已跑过）：状态机快进到 published。
    // 只拦开赛后/已终结的（锁定终版后再发布会破坏战绩口径）。
    const FAST_FORWARD = ["scheduled", "collecting", "ready", "analyzed"];
    if (!FAST_FORWARD.includes(match.status) && match.status !== "published") {
      throw new HttpError(400, `当前比赛状态（${match.status}）不可发布（已开赛/已结算/已作废）`);
    }
    const contentHash = computeAnalysisHash(row);
    tx.update(analyses)
      .set({
        status: "published",
        contentHash,
        prevHash: chainHead(),
        publishedAt: now(),
        updatedAt: now(),
      })
      .where(eq(analyses.id, analysisId))
      .run();
    // 同场旧的已发布版本保持 published 状态留在链上（历史版本），结算时统一转 public
    const price = opts.pricePoints ?? match.pricePoints ?? getConfig("pricing").defaultPricePoints;
    tx.update(matches)
      .set({
        pricePoints: price,
        updatedAt: now(),
        ...(FAST_FORWARD.includes(match.status) ? { status: "published" as const } : {}),
      })
      .where(eq(matches.id, match.id))
      .run();
  });
  if (opts.adminId) {
    logAudit({ actorId: opts.adminId, action: "publish", entity: "analysis", entityId: analysisId, detail: { pricePoints: opts.pricePoints } });
  }
}

/** 仅草稿可编辑定性段落与定价 */
export function updateDraftSections(
  analysisId: number,
  input: { thesis?: string; drivers?: string[]; risks?: string[] },
  adminId: number,
): void {
  const row = db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
  if (!row) throw new HttpError(404, "分析不存在");
  if (row.status !== "draft") throw new HttpError(400, "已发布的报告不可修改（如需更正请生成新版本）");
  const sections = row.llmSections ? JSON.parse(row.llmSections) : {};
  const merged = { ...sections, ...input };
  // 重新渲染 reportMd 中的定性段落：直接替换 llmSections，reportMd 由详情页按 JSON 渲染，
  // 规范文本在发布时重算 hash，因此这里同步更新 llmSections 即可。
  db.update(analyses)
    .set({ llmSections: JSON.stringify(merged), updatedAt: now() })
    .where(eq(analyses.id, analysisId))
    .run();
  logAudit({ actorId: adminId, action: "edit_report", entity: "analysis", entityId: analysisId, detail: input });
}

/** 比赛作废：腰斩/延期/管理员手动。全额退款、预测作废。 */
export function voidMatch(matchId: number, reason: string, adminId?: number): void {
  const match = db.select().from(matches).where(eq(matches.id, matchId)).get();
  if (!match) throw new HttpError(404, "比赛不存在");
  if (match.status === "void") return;
  if (match.status === "settled") throw new HttpError(400, "已结算的比赛不可作废");
  db.update(matches).set({ status: "void", updatedAt: now() }).where(eq(matches.id, matchId)).run();
  db.update(analyses)
    .set({ status: "void", updatedAt: now() })
    .where(and(eq(analyses.matchId, matchId), inArray(analyses.status, ["draft", "published"])))
    .run();
  db.update(predictions)
    .set({ result: "void", settledAt: now() })
    .where(eq(predictions.matchId, matchId))
    .run();
  const refunded = refundMatchUnlocks(matchId, `比赛作废退款：${reason}`);
  if (adminId) {
    logAudit({ actorId: adminId, action: "void_match", entity: "match", entityId: matchId, detail: { reason, refunded } });
  }
}

export interface VerifyResult {
  valid: boolean;
  analysisId: number;
  storedHash: string | null;
  computedHash: string;
  prevHashOk: boolean;
  detail: string;
}

/** 公开可验：重算内容哈希 + 校验链上前驱（仅对已发布/已公开版本开放，防 ID 遍历枚举草稿） */
export function verifyAnalysis(analysisId: number): VerifyResult {
  const row = db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
  // 未发布的草稿一律按"不存在"处理：不向匿名者泄露草稿存在性与发布节奏
  if (!row || !row.publishedAt || !row.contentHash || !["published", "public"].includes(row.status)) {
    throw new HttpError(404, "分析不存在");
  }
  const computedHash = computeAnalysisHash(row);
  const contentOk = computedHash === row.contentHash;
  // 找到链上紧邻前驱：publishedAt 早于本行的最新一份
  const prior = db
    .select({ contentHash: analyses.contentHash, publishedAt: analyses.publishedAt, id: analyses.id })
    .from(analyses)
    .where(isNotNull(analyses.publishedAt))
    .orderBy(desc(analyses.publishedAt), desc(analyses.id))
    .all()
    .find((r) => (r.publishedAt! < row.publishedAt!) || (r.publishedAt === row.publishedAt && r.id < row.id));
  const prevHashOk = (prior?.contentHash ?? null) === row.prevHash;
  return {
    valid: contentOk && prevHashOk,
    analysisId,
    storedHash: row.contentHash,
    computedHash,
    prevHashOk,
    detail: contentOk
      ? prevHashOk
        ? "内容哈希与链式前驱校验均通过：本报告自发布以来未被修改"
        : "内容完整，但链式前驱不匹配（链上可能有版本被删除）"
      : "内容哈希不匹配：报告内容与发布时不一致",
  };
}
