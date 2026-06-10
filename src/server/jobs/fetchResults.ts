import { z } from "zod";
import { fetchLeagueSeasonCsv, seasonCodes } from "../datasources/footballDataCouk";
import { chatCompletion, LlmUnavailableError } from "../llm/apiyi";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { matchesByStatus } from "../services/matchesService";
import { recordOutcome } from "../services/settle";
import { leagueById, teamNameById } from "../services/teamResolver";

/**
 * 赛后赛果回填：
 * 1) CSV 源比赛：用结果 CSV 自动回填（站方权威数据，直接生效）
 * 2) 其他来源：AI 检索（provisional，须管理员确认后才结算）
 */

export async function fetchResultsFromCsv(): Promise<number> {
  const due = matchesByStatus(["in_play"]).filter(
    (m) => m.source === "csv" && m.extId && now() - m.kickoffAt > 2.5 * 3_600_000,
  );
  if (due.length === 0) return 0;
  const cfg = getConfig("datasources");
  const divs = [...new Set(due.map((m) => m.extId!.split("|")[0]))];
  const [season] = seasonCodes(now(), 1);
  let filled = 0;
  for (const div of divs) {
    let rows;
    try {
      ({ rows } = await fetchLeagueSeasonCsv(cfg.csvBase, div, season));
    } catch {
      continue;
    }
    for (const m of due) {
      const [mdiv, , home, away] = m.extId!.split("|");
      if (mdiv !== div) continue;
      const hit = rows.find(
        (r) =>
          r.homeTeam === home &&
          r.awayTeam === away &&
          Math.abs(r.playedAt - m.kickoffAt) < 3 * 86_400_000,
      );
      if (hit) {
        recordOutcome({
          matchId: m.id,
          homeGoals: hit.fthg,
          awayGoals: hit.ftag,
          htHome: hit.hthg,
          htAway: hit.htag,
          source: "csv",
          provisional: false,
        });
        filled++;
      }
    }
  }
  return filled;
}

const aiResultSchema = z.object({
  known: z.boolean(),
  homeGoals: z.number().int().min(0).max(20).nullable(),
  awayGoals: z.number().int().min(0).max(20).nullable(),
  status: z.enum(["finished", "abandoned", "postponed", "unknown"]).default("unknown"),
});

export async function fetchResultsViaAi(): Promise<number> {
  const due = matchesByStatus(["in_play"]).filter(
    (m) => m.source !== "csv" && now() - m.kickoffAt > 2.5 * 3_600_000,
  );
  let filled = 0;
  for (const m of due) {
    const league = leagueById(m.leagueId);
    try {
      const raw = await chatCompletion({
        system:
          "你是体育赛果核对员。只有当你确切知道指定比赛的最终比分（90分钟+伤停补时常规时间比分）时才返回，" +
          '不确定一律 known=false。输出 JSON：{"known":bool,"homeGoals":int|null,"awayGoals":int|null,"status":"finished|abandoned|postponed|unknown"}',
        user: `比赛：${league?.name ?? ""} ${m.round ?? ""}，${teamNameById(m.homeTeamId)} vs ${teamNameById(m.awayTeamId)}，开球（UTC）：${new Date(m.kickoffAt).toISOString()}。请给出常规时间最终比分。`,
        json: true,
        maxTokens: 100,
        mock: JSON.stringify({ known: false, homeGoals: null, awayGoals: null, status: "unknown" }),
      });
      const parsed = aiResultSchema.parse(JSON.parse(raw));
      if (parsed.known && parsed.homeGoals !== null && parsed.awayGoals !== null && parsed.status === "finished") {
        recordOutcome({
          matchId: m.id,
          homeGoals: parsed.homeGoals,
          awayGoals: parsed.awayGoals,
          source: "llm",
          provisional: true, // 管理员确认后才结算
        });
        filled++;
      }
    } catch (e) {
      if (!(e instanceof LlmUnavailableError)) {
        console.warn(`[jobs] AI 赛果检索失败 match=${m.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  return filled;
}
