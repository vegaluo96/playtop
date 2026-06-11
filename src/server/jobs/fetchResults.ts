import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { outcomes } from "../db/schema";
import { fetchLeagueSeasonCsv, seasonCodes } from "../datasources/footballDataCouk";
import { chatCompletion, LlmUnavailableError } from "../llm/apiyi";
import { getConfig } from "../lib/config";
import { now } from "../lib/time";
import { matchesByStatus } from "../services/matchesService";
import { confirmOutcomeRow, recordOutcome } from "../services/settle";
import { isSourceUsable, withSource } from "../services/sourceHealth";
import { leagueById, teamNameById } from "../services/teamResolver";
import { ESPN_LEAGUE_SLUG, fetchEspnScoreboard, matchEspnEvent } from "../datasources/espn";
import { afFixtureFinished, apiFootballConfigured, fetchAfFixturesByDate, matchAfFixture } from "../datasources/apiFootball";
import { teams } from "../db/schema";

/**
 * 赛后赛果回填：
 * 1) CSV 源比赛：用结果 CSV 自动回填（站方权威数据，直接生效）
 * 2) 其他来源：AI 检索（provisional）；double_check 策略下两次独立检索
 *    同比分（间隔 ≥90 分钟）即自动确认结算，异分覆盖并重置时钟
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

/**
 * API-Football 权威赛果（付费主源，最先执行）：按比赛日分组、一日一拉，
 * fulltime 字段即 90 分钟口径比分，FT/AET/PEN 直接确认结算。未配置 key 时整段跳过。
 */
export async function fetchResultsFromApiFootball(): Promise<number> {
  const ds = getConfig("datasources");
  if (!apiFootballConfigured() || !isSourceUsable("api_football", ds.apiFootballEnabled)) return 0;
  const due = matchesByStatus(["in_play"]).filter((m) => now() - m.kickoffAt > 2 * 3_600_000);
  if (due.length === 0) return 0;
  let filled = 0;
  const byDate = new Map<string, typeof due>();
  for (const m of due) {
    const d = new Date(m.kickoffAt).toISOString().slice(0, 10);
    byDate.set(d, [...(byDate.get(d) ?? []), m]);
  }
  for (const [date, ms] of byDate) {
    let fixtures;
    try {
      fixtures = await withSource("api_football", () => fetchAfFixturesByDate(date));
    } catch (e) {
      console.warn(`[jobs] API-Football 赛果抓取失败 ${date}:`, e instanceof Error ? e.message : e);
      continue;
    }
    for (const m of ms) {
      const teamNames = (teamId: number) => {
        const t = db.select().from(teams).where(eq(teams.id, teamId)).get();
        return t ? [t.name, ...(JSON.parse(t.aliases) as string[])] : [];
      };
      const hit = matchAfFixture(fixtures, {
        homeNames: teamNames(m.homeTeamId),
        awayNames: teamNames(m.awayTeamId),
        kickoffAt: m.kickoffAt,
      });
      if (hit && afFixtureFinished(hit)) {
        recordOutcome({
          matchId: m.id,
          homeGoals: hit.ftHome!,
          awayGoals: hit.ftAway!,
          source: "api_football",
          provisional: false, // 持牌数据商：权威级直接结算
        });
        filled++;
      }
    }
  }
  return filled;
}

/**
 * ESPN 权威赛果：非 CSV 场次（世界杯/手动）按联赛 slug 分组拉当日 scoreboard，
 * 双队名+开球时间匹配，FT 即直接确认结算（等同官方 CSV 信任级，AI 双确认降为兜底）。
 */
export async function fetchResultsFromEspn(): Promise<number> {
  const ds = getConfig("datasources");
  if (!isSourceUsable("espn", ds.espnEnabled)) return 0;
  const due = matchesByStatus(["in_play"]).filter((m) => m.source !== "csv" && now() - m.kickoffAt > 2 * 3_600_000);
  if (due.length === 0) return 0;
  let filled = 0;
  // 按 (slug, 比赛日) 分组：一次抓取覆盖同日同赛事全部场次
  const groups = new Map<string, typeof due>();
  for (const m of due) {
    const slug = ESPN_LEAGUE_SLUG[leagueById(m.leagueId)?.code ?? ""];
    if (!slug) continue;
    const key = `${slug}|${new Date(m.kickoffAt).toISOString().slice(0, 10).replace(/-/g, "")}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const [key, ms] of groups) {
    const [slug, date] = key.split("|");
    let events;
    try {
      events = await withSource("espn", () => fetchEspnScoreboard(slug, date));
    } catch (e) {
      console.warn(`[jobs] ESPN 赛果抓取失败 ${key}:`, e instanceof Error ? e.message : e);
      continue;
    }
    for (const m of ms) {
      const teamNames = (teamId: number) => {
        const t = db.select().from(teams).where(eq(teams.id, teamId)).get();
        return t ? [t.name, ...(JSON.parse(t.aliases) as string[])] : [];
      };
      const hit = matchEspnEvent(events, {
        homeNames: teamNames(m.homeTeamId),
        awayNames: teamNames(m.awayTeamId),
        kickoffAt: m.kickoffAt,
      });
      if (hit?.completed && hit.homeScore !== null && hit.awayScore !== null) {
        recordOutcome({
          matchId: m.id,
          homeGoals: hit.homeScore,
          awayGoals: hit.awayScore,
          source: "espn",
          provisional: false, // 权威级：直接结算
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
    // 已有确认赛果（ESPN/人工）则跳过，省 token
    const confirmed = db.select().from(outcomes).where(eq(outcomes.matchId, m.id)).get();
    if (confirmed && confirmed.provisional === 0) continue;
    const league = leagueById(m.leagueId);
    try {
      const raw = await chatCompletion({
        system:
          "你是体育赛果核对员。只有当你确切知道指定比赛的最终比分（90分钟+伤停补时常规时间比分）时才返回，" +
          '不确定一律 known=false。输出 JSON：{"known":bool,"homeGoals":int|null,"awayGoals":int|null,"status":"finished|abandoned|postponed|unknown"}',
        user: `比赛：${league?.name ?? ""} ${m.round ?? ""}，${teamNameById(m.homeTeamId)} vs ${teamNameById(m.awayTeamId)}，开球（UTC）：${new Date(m.kickoffAt).toISOString()}。请给出常规时间最终比分。`,
        json: true,
        maxTokens: 100,
        task: "retrieval",
        mock: JSON.stringify({ known: false, homeGoals: null, awayGoals: null, status: "unknown" }),
      });
      const parsed = aiResultSchema.parse(JSON.parse(raw));
      if (parsed.known && parsed.homeGoals !== null && parsed.awayGoals !== null && parsed.status === "finished") {
        // double_check 安全栏：先看上一次 AI 检索结果（再录入，避免时钟被重置）
        const existing = db.select().from(outcomes).where(eq(outcomes.matchId, m.id)).get();
        const auto = getConfig("automation");
        const doubleChecked =
          existing !== undefined &&
          existing.provisional === 1 &&
          existing.source === "llm" &&
          existing.homeGoals === parsed.homeGoals &&
          existing.awayGoals === parsed.awayGoals &&
          now() - existing.recordedAt >= 90 * 60_000;
        recordOutcome({
          matchId: m.id,
          homeGoals: parsed.homeGoals,
          awayGoals: parsed.awayGoals,
          source: "llm",
          provisional: true,
        });
        if (auto.autoConfirmAiResults && auto.aiResultConfirmPolicy === "double_check" && doubleChecked) {
          confirmOutcomeRow(m.id, { auto: true }); // 两次独立检索一致 → 自动确认，下个状态机 tick 结算
        }
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
