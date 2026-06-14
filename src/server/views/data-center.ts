import { dateStr, hhmm } from "@/lib/format";
import { dig } from "@/lib/dig";
import { leagueColor, leagueZh, roundZh } from "@/lib/leagues";
import { db } from "../db";
import { runAfEndpoint } from "../af/catalog";
import { isFinished, isLive } from "../af/schedule";
import { kvCached, upsertPlayerIndex, type FixtureRow } from "../af/store";
import { cfgLeagues } from "../platform/config";
import { nameZh } from "./names";
import { publicImageUrl, teamLogoFromFixturePayload } from "./team-assets";

const H = 3_600_000;
const EMPTY_TTL_MS = 30 * 60_000;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function groupZh(raw: string, fallback: string): string {
  const text = raw.trim();
  const m = /^Group\s+([A-Z\d]{1,2})$/i.exec(text);
  if (m) return `${m[1].toUpperCase()}组`;
  return text || fallback;
}

async function resolveSeason(leagueId: number): Promise<{ season: number; source: "cache" | "official" | "inferred" }> {
  const row = db()
    .prepare(
      `SELECT season
       FROM fixtures_cache
       WHERE league_id = ? AND season > 0
       GROUP BY season
       ORDER BY MIN(ABS(kickoff_utc - ?)) ASC
       LIMIT 1`,
    )
    .get(leagueId, Date.now()) as { season: number } | undefined;
  if (row?.season) return { season: row.season, source: "cache" };

  const official = await kvCached<number | null>(
    `data:${leagueId}:current-season`,
    7 * 24 * H,
    async () => {
      const r = await runAfEndpoint("leagues", { id: String(leagueId), current: "true" });
      const item = arr(r.response)[0];
      const seasons = arr(dig(item, "seasons"));
      const current = seasons.find((s) => dig(s, "current") === true) ?? seasons.at(-1);
      const y = Number(dig(current, "year"));
      return Number.isFinite(y) && y > 0 ? y : null;
    },
    { emptyTtlMs: EMPTY_TTL_MS },
  ).catch(() => null);
  if (official) return { season: official, source: "official" };
  return { season: new Date(Date.now() + 8 * H).getUTCFullYear(), source: "inferred" };
}

async function standingsGroups(leagueId: number, season: number) {
  const groups = await kvCached<unknown[]>(
    `data:${leagueId}:${season}:standings`,
    30 * 60_000, // 积分榜赛中(尤其世界杯)逐场变化,30min 缓存避免「过期」观感(原 6h 太久)
    async () => {
      const r = await runAfEndpoint("standings", { league: String(leagueId), season: String(season) });
      return arr(dig(arr(r.response)[0], "league", "standings"));
    },
    { emptyTtlMs: EMPTY_TTL_MS },
  ).catch(() => [] as unknown[]);

  return groups
    .map((g, groupIndex) => {
      const rows = arr(g).map((row) => {
        const teamId = Number(dig(row, "team", "id")) || null;
        const gf = Number(dig(row, "all", "goals", "for")) || 0;
        const ga = Number(dig(row, "all", "goals", "against")) || 0;
        return {
          rank: Number(dig(row, "rank")) || 0,
          teamId,
          team: nameZh(String(dig(row, "team", "name") ?? "")),
          logo: publicImageUrl(dig(row, "team", "logo")),
          played: Number(dig(row, "all", "played")) || 0,
          win: Number(dig(row, "all", "win")) || 0,
          draw: Number(dig(row, "all", "draw")) || 0,
          lose: Number(dig(row, "all", "lose")) || 0,
          goals: `${gf}/${ga}`,
          diff: Number(dig(row, "goalsDiff")) || 0,
          points: Number(dig(row, "points")) || 0,
          note: String(dig(row, "description") ?? "").trim(),
          form: String(dig(row, "form") ?? "").slice(-5),
        };
      });
      const rawGroup = String(dig(rows.length > 0 ? arr(g)[0] : null, "group") ?? "");
      return { group: groupZh(rawGroup, groups.length > 1 ? `第 ${groupIndex + 1} 组` : "积分榜"), rows };
    })
    .filter((group) => group.rows.length > 0);
}

function playerBoardRow(item: unknown, index: number) {
  const stat = arr(dig(item, "statistics"))[0];
  const teamId = Number(dig(stat, "team", "id")) || null;
  const playerId = Number(dig(item, "player", "id")) || null;
  const goals = Number(dig(stat, "goals", "total")) || 0;
  const assists = Number(dig(stat, "goals", "assists")) || 0;
  return {
    rank: index + 1,
    playerId,
    player: nameZh(String(dig(item, "player", "name") ?? ""), "player"),
    photo: publicImageUrl(dig(item, "player", "photo")),
    teamId,
    team: nameZh(String(dig(stat, "team", "name") ?? "")),
    teamLogo: publicImageUrl(dig(stat, "team", "logo")),
    goals,
    assists,
    penalty: Number(dig(stat, "penalty", "scored")) || 0,
  };
}

async function playerBoard(leagueId: number, season: number, kind: "players.topscorers" | "players.topassists") {
  const rows = await kvCached<unknown[]>(
    `data:${leagueId}:${season}:${kind}`,
    3 * H, // 射手/助攻榜随比赛日更新,3h 缓存(原 24h 太久,赛中观感过期)
    async () => {
      const r = await runAfEndpoint(kind, { league: String(leagueId), season: String(season) });
      return arr(r.response);
    },
    { emptyTtlMs: EMPTY_TTL_MS },
  ).catch(() => [] as unknown[]);
  const top = rows.slice(0, 30);
  // 顺带把榜单球员写入 player_index,供全局搜索命中(译名在此处先汉化好,避免 store→names 循环依赖)
  upsertPlayerIndex(
    top.map((it) => {
      const stat = arr(dig(it, "statistics"))[0];
      const raw = String(dig(it, "player", "name") ?? "");
      return {
        playerId: Number(dig(it, "player", "id")) || 0,
        name: raw,
        nameZh: nameZh(raw, "player"),
        teamId: Number(dig(stat, "team", "id")) || null,
        teamName: nameZh(String(dig(stat, "team", "name") ?? "")),
        leagueId,
        season,
      };
    }),
  );
  return top.map(playerBoardRow);
}

function scheduleRows(leagueId: number, season: number, tz: string) {
  const now = Date.now();
  const from = now - 14 * 24 * H;
  const to = now + 45 * 24 * H;
  let rows = db()
    .prepare(
      `SELECT * FROM fixtures_cache
       WHERE league_id = ? AND season = ? AND kickoff_utc >= ? AND kickoff_utc <= ?
       ORDER BY kickoff_utc ASC
       LIMIT 120`,
    )
    .all(leagueId, season, from, to) as unknown as FixtureRow[];
  if (rows.length === 0) {
    rows = db()
      .prepare(
        `SELECT * FROM fixtures_cache
         WHERE league_id = ? AND season = ?
         ORDER BY ABS(kickoff_utc - ?) ASC
         LIMIT 80`,
      )
      .all(leagueId, season, now) as unknown as FixtureRow[];
    rows.sort((a, b) => a.kickoff_utc - b.kickoff_utc);
  }

  return rows.map((f) => ({
    id: f.fixture_id,
    round: roundZh(f.round),
    date: dateStr(f.kickoff_utc, tz).slice(5),
    time: hhmm(f.kickoff_utc, tz),
    live: isLive(f.status),
    finished: isFinished(f.status),
    status: isLive(f.status) ? (f.status === "HT" ? "中场" : f.elapsed != null ? `${f.elapsed}'` : "进行中") : isFinished(f.status) ? "已完场" : "未开赛",
    home: nameZh(f.home_name),
    away: nameZh(f.away_name),
    homeId: f.home_id,
    awayId: f.away_id,
    homeLogo: teamLogoFromFixturePayload(f.payload, "home"),
    awayLogo: teamLogoFromFixturePayload(f.payload, "away"),
    score: f.goals_home != null && f.goals_away != null ? `${f.goals_home}-${f.goals_away}` : "VS",
  }));
}

export async function dataCenterView(input: { leagueId?: number | null; tz?: string }) {
  const leagues = cfgLeagues().filter((l) => l.on);
  const fallback = leagues[0] ?? { id: 1, zh: "世界杯", color: leagueColor(1), on: true, wc: true };
  const selected = leagues.find((l) => l.id === input.leagueId) ?? fallback;
  const { season, source: seasonSource } = await resolveSeason(selected.id);
  const [standings, scorers, assists] = await Promise.all([
    standingsGroups(selected.id, season),
    playerBoard(selected.id, season, "players.topscorers"),
    playerBoard(selected.id, season, "players.topassists"),
  ]);

  return {
    ok: true,
    league: {
      id: selected.id,
      zh: selected.zh || leagueZh(selected.id, ""),
      color: selected.color || leagueColor(selected.id),
      wc: selected.wc ?? false,
    },
    season,
    seasonSource,
    standings,
    scorers,
    assists,
    schedule: scheduleRows(selected.id, season, input.tz || "UTC+8"),
  };
}
