import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { analyses, historyMatches, leagues, type MatchStatus } from "../db/schema";
import { runEngine } from "../engine";
import {
  engineOutputSchema,
  type EngineBundle,
  type EngineOutput,
  type EngineParams,
  type HistMatch,
  type InjuryItem,
  type NormalizedOdds,
} from "../engine/types";
import { getConfig } from "../lib/config";
import { hashObject } from "../lib/hash";
import { now } from "../lib/time";
import {
  externalRatingsPayloadSchema,
  formPayloadSchema,
  h2hPayloadSchema,
  injuriesPayloadSchema,
  coachPayloadSchema,
  lineupsPayloadSchema,
  playerStatsPayloadSchema,
  refereePayloadSchema,
  softInfoPayloadSchema,
  standingsPayloadSchema,
  weatherPayloadSchema,
} from "../datasources/types";
import { INTERNATIONAL_LEAGUE_CODE } from "../datasources/international";
import {
  generateLlmSections,
  llmSectionsSchema,
  renderReportMd,
  type LlmSections,
  type ReportContext,
} from "../llm/reportWriter";
import { getRating } from "./eloService";
import { getMatch, transitionMatch } from "./matchesService";
import { latestOddsBookRows, latestOddsBooks, latestSnapshots, oddsSeries, snapshotPayload, snapshotStats, KIND_LABELS } from "./snapshots";
import { leagueById, teamNameById } from "./teamResolver";
import { publishAnalysisRow } from "./publish";
import { qualitativePhrases } from "../llm/reportWriter";
import { recordV2Artifacts, snapshotTypeForKickoff } from "../v2/pipeline";

const HISTORY_WINDOW_DAYS = 1100;
const HISTORY_CAP = 3000;
/** 集成概率最大分量变化 ≥ 2pp 才重新生成 LLM 定性段落（控制 token 成本） */
const LLM_REGEN_DELTA = 0.02;

export function engineParamsFromConfig(): EngineParams {
  const cfg = getConfig("engine");
  return {
    xi: cfg.xi,
    rho: cfg.rho,
    homeAdvElo: cfg.homeAdvElo,
    eloK0: cfg.eloK0,
    eloGoalDiffExp: cfg.eloGoalDiffExp,
    eloCalib: cfg.eloCalib,
    ensembleWeights: cfg.ensembleWeights,
    bookWeights: cfg.bookWeights,
    kellyFraction: cfg.kellyFraction,
    kellyCap: cfg.kellyCap,
    evThreshold: cfg.evThreshold,
    minProbForPick: cfg.minProbForPick,
    adjustmentsEnabled: cfg.adjustmentsEnabled,
    shotsBlendTheta: cfg.shotsBlendTheta,
  };
}

/** 国际类联赛（世界杯/INT 等，country=国际）共享同一个国家队历史池——否则 WC2026 联赛下无历史，DC 永远退化 */
function historyLeagueIds(leagueId: number): number[] {
  const lg = leagueById(leagueId);
  if (lg?.country === "国际") {
    return db
      .select({ id: leagues.id })
      .from(leagues)
      .where(eq(leagues.country, "国际"))
      .all()
      .map((r) => r.id);
  }
  return [leagueId];
}

function loadLeagueHistory(leagueId: number, refTime: number): HistMatch[] {
  const rows = db
    .select()
    .from(historyMatches)
    .where(
      and(
        inArray(historyMatches.leagueId, historyLeagueIds(leagueId)),
        gte(historyMatches.playedAt, refTime - HISTORY_WINDOW_DAYS * 86_400_000),
        lt(historyMatches.playedAt, refTime),
      ),
    )
    .orderBy(desc(historyMatches.playedAt))
    .limit(HISTORY_CAP)
    .all();
  return rows.map((r) => {
    const stats = r.stats ? (JSON.parse(r.stats) as Record<string, number | null>) : {};
    return {
      homeTeamId: r.homeTeamId,
      awayTeamId: r.awayTeamId,
      homeGoals: r.homeGoals,
      awayGoals: r.awayGoals,
      playedAt: r.playedAt,
      neutral: r.neutral === 1,
      homeShots: stats.homeShots ?? undefined,
      homeSot: stats.homeSot ?? undefined,
      awayShots: stats.awayShots ?? undefined,
      awaySot: stats.awaySot ?? undefined,
    };
  });
}

/** 与 computedAt/trace 无关的引擎输出指纹（判断"是否真的变了"） */
export function stableEngineHash(output: EngineOutput): string {
  return hashObject({ ...output, computedAt: 0, trace: [] });
}

export function latestAnalysis(matchId: number) {
  return (
    db
      .select()
      .from(analyses)
      .where(eq(analyses.matchId, matchId))
      .orderBy(desc(analyses.version))
      .limit(1)
      .get() ?? null
  );
}

export interface AnalyzeResult {
  analysisId: number;
  version: number;
  changed: boolean;
  autoPublished: boolean;
}

/**
 * 建模 + 报告生成。可反复执行：
 * - 引擎输出与上版相同 → 不产生新版本（changed=false）
 * - 比赛已 published 且 autoPublishRevision → 新版本自动发布（实时改版）
 */
export async function analyzeMatch(
  matchId: number,
  opts: { autoPublishRevision?: boolean } = {},
): Promise<AnalyzeResult> {
  const match = getMatch(matchId);
  const league = leagueById(match.leagueId);
  const homeName = teamNameById(match.homeTeamId);
  const awayName = teamNameById(match.awayTeamId);
  const snaps = latestSnapshots(matchId);

  const odds = snapshotPayload<NormalizedOdds>(snaps.get("odds"));
  const injuriesPayload = snapshotPayload<z.infer<typeof injuriesPayloadSchema>>(snaps.get("injuries"));
  const suspensionsPayload = snapshotPayload<z.infer<typeof injuriesPayloadSchema>>(snaps.get("suspensions"));
  const weather = snapshotPayload<z.infer<typeof weatherPayloadSchema>>(snaps.get("weather"));
  const injuries: InjuryItem[] = [
    ...(injuriesPayload?.items ?? []),
    ...(suspensionsPayload?.items ?? []).map((i) => ({ ...i, status: i.status || "停赛" })),
  ].map((i) => ({ team: i.team, player: i.player, role: i.role, importance: i.importance, status: i.status }));

  const computedAt = now();
  const bundle: EngineBundle = {
    match: {
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      kickoffAt: match.kickoffAt,
      neutralVenue: match.neutral === 1,
    },
    odds: odds ?? undefined,
    books: latestOddsBooks(matchId),
    oddsSeries: oddsSeries(matchId),
    injuries,
    weather: weather
      ? {
          temperatureC: weather.temperatureC ?? undefined,
          precipitationMmH: weather.precipitationMmH ?? undefined,
          windKmH: weather.windKmH ?? undefined,
          summary: weather.summary,
        }
      : undefined,
    leagueHistory: loadLeagueHistory(match.leagueId, computedAt),
    elo: {
      home: { rating: getRating(match.homeTeamId).rating, matchesPlayed: getRating(match.homeTeamId).matchesPlayed },
      away: { rating: getRating(match.awayTeamId).rating, matchesPlayed: getRating(match.awayTeamId).matchesPlayed },
    },
    computedAt,
  };

  const engine = runEngine(bundle, engineParamsFromConfig());

  const prev = latestAnalysis(matchId);
  const prevEngine = prev ? engineOutputSchema.parse(JSON.parse(prev.engineOutput)) : null;
  if (prevEngine && stableEngineHash(prevEngine) === stableEngineHash(engine)) {
    return { analysisId: prev!.id, version: prev!.version, changed: false, autoPublished: false };
  }
  const version = (prev?.version ?? 0) + 1;

  // 事实清单（数字白名单来源 + LLM 上下文）
  const facts: string[] = [];
  const h2h = snapshotPayload<z.infer<typeof h2hPayloadSchema>>(snaps.get("h2h"));
  if (h2h && h2h.summary.total > 0) {
    facts.push(
      `历史交锋近${h2h.summary.total}场：${homeName} ${h2h.summary.homeWins}胜 ${h2h.summary.draws}平 ${h2h.summary.awayWins}负`,
    );
  }
  const form = snapshotPayload<z.infer<typeof formPayloadSchema>>(snaps.get("form"));
  if (form) {
    facts.push(`${homeName}${form.home.summaryText}`);
    facts.push(`${awayName}${form.away.summaryText}`);
  }
  const standings = snapshotPayload<z.infer<typeof standingsPayloadSchema>>(snaps.get("standings"));
  if (standings?.homeRank && standings.awayRank) {
    facts.push(`积分榜排名：${homeName}第${standings.homeRank}，${awayName}第${standings.awayRank}`);
  }
  for (const i of injuries) {
    facts.push(`${i.team === "home" ? homeName : awayName}缺阵：${i.player}（${i.status}）`);
  }
  const lineups = snapshotPayload<z.infer<typeof lineupsPayloadSchema>>(snaps.get("lineups"));
  if (lineups && (lineups.home.starters.length > 0 || lineups.away.starters.length > 0)) {
    facts.push(
      `阵容（${lineups.confirmed ? "官方确认" : "预计，未经官方确认"}）：` +
        `${homeName} ${lineups.home.formation ?? ""} ${lineups.home.starters.slice(0, 11).join("、") || "未知"}；` +
        `${awayName} ${lineups.away.formation ?? ""} ${lineups.away.starters.slice(0, 11).join("、") || "未知"}` +
        `${lineups.note ? `（${lineups.note}）` : ""}`,
    );
  }
  if (weather?.summary) facts.push(`开球时段天气：${weather.summary}`);
  const coach = snapshotPayload<z.infer<typeof coachPayloadSchema>>(snaps.get("coach"));
  if (coach?.home.name || coach?.away.name) {
    facts.push(`主教练：${homeName} ${coach.home.name || "未知"}；${awayName} ${coach.away.name || "未知"}`);
    if (coach.home.note) facts.push(`${homeName}教练动态：${coach.home.note}`);
    if (coach.away.note) facts.push(`${awayName}教练动态：${coach.away.note}`);
  }
  const referee = snapshotPayload<z.infer<typeof refereePayloadSchema>>(snaps.get("referee"));
  if (referee?.name) facts.push(`主裁判：${referee.name}${referee.note ? `（${referee.note}）` : ""}`);
  const soft = snapshotPayload<z.infer<typeof softInfoPayloadSchema>>(snaps.get("soft_info"));
  for (const item of soft?.items ?? []) facts.push(`${item.topic}：${item.content}`);
  // 外部评级（eloratings.net / ClubElo / Understat xG）与球员数据（射手榜/点球史）入事实清单
  const ratings = snapshotPayload<z.infer<typeof externalRatingsPayloadSchema>>(snaps.get("external_ratings"));
  for (const r of ratings?.items ?? []) {
    facts.push(
      `${r.team === "home" ? homeName : awayName}外部评级（${r.source}）：${r.rating}` +
        `${r.rank != null ? `，排名第${r.rank}` : ""}${r.note ? `（${r.note}）` : ""}`,
    );
  }
  const ps = snapshotPayload<z.infer<typeof playerStatsPayloadSchema>>(snaps.get("player_stats"));
  for (const i of (ps?.items ?? []).slice(0, 6)) {
    facts.push(`${i.team === "home" ? homeName : awayName}射手：${i.player}${i.note ? `（${i.note}）` : ""}`);
  }
  for (const n of ps?.notes ?? []) facts.push(n);

  const stats = snapshotStats(matchId);
  const ctx: ReportContext = {
    match: {
      leagueName: league?.name ?? "",
      homeName,
      awayName,
      kickoffAt: match.kickoffAt,
      venue: match.venue,
      round: match.round,
      neutral: match.neutral === 1,
    },
    engine,
    version,
    prevEnsemble: prevEngine?.ensemble.probs ?? null,
    snapshots: stats.perKind.map((s) => ({
      kind: s.kind,
      kindLabel: s.kindLabel,
      source: sourceLabel(s.source),
      fetchedAt: s.fetchedAt,
      count: s.count,
    })),
    missingKinds: stats.missing
      .filter((k) => {
        const isIntl = league?.code === INTERNATIONAL_LEAGUE_CODE || league?.code === "WC2026";
        if (isIntl && k === "standings") return false; // 国际赛无积分榜
        if (!isIntl && k === "player_stats") return false; // 射手数据集仅覆盖国家队
        return true;
      })
      .map((k) => KIND_LABELS[k]),
    facts,
    totalSnapshotCount: stats.total,
  };

  // 定性段落：变化不大时复用上一版（标注 generatedAtVersion），显著变化才重新生成
  let sections: LlmSections;
  const prevSections = prev?.llmSections
    ? (JSON.parse(prev.llmSections) as LlmSections)
    : null;
  const delta = prevEngine
    ? Math.max(
        Math.abs(engine.ensemble.probs.home - prevEngine.ensemble.probs.home),
        Math.abs(engine.ensemble.probs.draw - prevEngine.ensemble.probs.draw),
        Math.abs(engine.ensemble.probs.away - prevEngine.ensemble.probs.away),
      )
    : 1;
  if (prevSections && !prevSections.degraded && delta < LLM_REGEN_DELTA) {
    sections = prevSections;
  } else {
    sections = await generateLlmSections(ctx);
  }

  const reportMd = renderReportMd(ctx, llmSectionsSchema.parse(sections));
  const inserted = db
    .insert(analyses)
    .values({
      matchId,
      version,
      modelVersion: engine.modelVersion,
      engineOutput: JSON.stringify(engine),
      reportMd,
      llmSections: JSON.stringify(sections),
      // 可复现性审计：各维度最新快照 + 多书商盘口的每家最新一份（去重）
      inputSnapshotIds: JSON.stringify([
        ...new Set([...[...snaps.values()].map((s) => s.id), ...latestOddsBookRows(matchId).map(({ row }) => row.id)]),
      ]),
      status: "draft",
      createdAt: now(),
      updatedAt: now(),
    })
    .returning({ id: analyses.id })
    .get();

  // 建模成功即推进到"已建模"：手动从采集中/待采集直接运行引擎时沿合法迁移链快进
  const FF: Record<string, MatchStatus> = { scheduled: "collecting", collecting: "ready", ready: "analyzed" };
  let st = getMatch(matchId).status;
  while (FF[st]) {
    transitionMatch(matchId, FF[st]);
    st = FF[st];
  }

  // ── V2 钩子：对象链一等公民落库（快照归并/盘口扁平化/ModelRun/ReportVersion）。
  // 复用本次已算好的 bundle/engine/sections，零双倍计算；V2 失败绝不阻塞 V1 链路。
  try {
    recordV2Artifacts({
      matchId,
      bundle,
      engine,
      versionType: snapshotTypeForKickoff(match.kickoffAt, computedAt),
      title: `${ctx.match.leagueName}${ctx.match.round ? ` ${ctx.match.round}` : ""}：${homeName} vs ${awayName} · 赛前量化研报 V${version}`,
      freePreview: JSON.stringify({
        ensemble: engine.ensemble.probs,
        fallbackLevel: engine.fallbackLevel,
        pickCount: engine.picks.length,
        thesis: sections.thesis,
      }),
      paidContent: reportMd,
      summary: { ensemble: engine.ensemble.probs, picks: engine.picks, marketBooks: engine.market?.books.length ?? 0 },
      whitelistSource: [...facts, ...qualitativePhrases(ctx)],
    });
  } catch (e) {
    console.warn(`[v2] artifacts 记录失败 match=${matchId}:`, e instanceof Error ? e.message : e);
  }

  let autoPublished = false;
  if (opts.autoPublishRevision && match.status === "published") {
    publishAnalysisRow(inserted.id, {});
    autoPublished = true;
  }
  return { analysisId: inserted.id, version, changed: true, autoPublished };
}

function sourceLabel(source: string): string {
  return (
    {
      football_data_couk: "football-data.co.uk",
      open_meteo: "open-meteo",
      local_stats: "本地历史库",
      llm: "AI 检索",
      manual: "人工录入",
      sporttery: "中国竞彩官方",
      polymarket: "Polymarket 预测市场",
    }[source] ?? source
  );
}
