/**
 * 球员资料卡:GET /api/player/<id>?season=&name=
 * players(赛季统计)+ profiles(档案)+ seasons(可用赛季)+ teams(效力队)+ sidelined(伤停/停赛史)。
 */
import { NextRequest, NextResponse } from "next/server";
import { kvCached } from "@/server/af/store";
import { runAfEndpoint } from "@/server/af/catalog";
import { nameZh } from "@/server/views/names";

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const POS_ZH: Record<string, string> = { Goalkeeper: "门将", Defender: "后卫", Midfielder: "中场", Attacker: "前锋" };
const SIDE_ZH: [RegExp, string][] = [
  [/suspend/i, "停赛"], [/red card/i, "红牌停赛"], [/yellow/i, "累积黄牌"], [/injur/i, "伤病"],
  [/knee/i, "膝伤"], [/hamstring/i, "腿筋伤"], [/ankle/i, "踝伤"], [/muscle|thigh|calf/i, "肌肉伤"],
  [/illness|virus/i, "疾病"], [/knock/i, "碰伤"], [/groin/i, "腹股沟伤"], [/back/i, "背伤"],
];
const sideZh = (t: string) => SIDE_ZH.find(([re]) => re.test(t))?.[1] ?? t;

const H = 3_600_000;
const DAY = 86_400_000;
const PLAYER_VIEW_TTL_MS = 6 * H;
const PLAYER_STATS_TTL_MS = 24 * H;
const PLAYER_PROFILE_TTL_MS = 30 * DAY;
const PLAYER_DYNAMIC_TTL_MS = 12 * H;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const pid = Number(id);
  if (!pid) return NextResponse.json({ ok: false, error: "无效的球员 id" }, { status: 400 });
  const season = Number(req.nextUrl.searchParams.get("season")) || new Date().getFullYear();

  try {
    const view = await kvCached(`player:view:${pid}:${season}:v2`, PLAYER_VIEW_TTL_MS, () => loadPlayerView(pid, season), { emptyTtlMs: 30 * 60_000 });
    if (!view) return NextResponse.json({ ok: false, error: "暂无该球员资料" }, { status: 404 });
    return NextResponse.json(view, {
      headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=3600" },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "拉取失败" }, { status: 502 });
  }
}

async function loadPlayerView(pid: number, season: number) {
  // 并行拉取:球员卡不再只靠 players 单端点,避免档案/赛季/效力轨迹空缺。
  const [item, profile, seasons, careerTeams, sidelined] = await Promise.all([
    kvCached<unknown>(`player:${pid}:${season}`, PLAYER_STATS_TTL_MS, async () => {
      const r = await runAfEndpoint("players", { id: String(pid), season: String(season) });
      return arr(r.response)[0] ?? null;
    }, { emptyTtlMs: 6 * H }),
    kvCached<unknown>(`player:${pid}:profile`, PLAYER_PROFILE_TTL_MS, async () => {
      const r = await runAfEndpoint("players.profiles", { player: String(pid) });
      return arr(r.response)[0] ?? null;
    }).catch(() => null),
    kvCached<unknown[]>(`player:${pid}:seasons`, PLAYER_PROFILE_TTL_MS, async () => {
      const r = await runAfEndpoint("players.seasons", { player: String(pid) });
      return arr(r.response);
    }).catch(() => [] as unknown[]),
    kvCached<unknown[]>(`player:${pid}:teams`, PLAYER_PROFILE_TTL_MS, async () => {
      const r = await runAfEndpoint("players.teams", { player: String(pid) });
      return arr(r.response);
    }).catch(() => [] as unknown[]),
    kvCached<unknown[]>(`player:${pid}:sidelined`, PLAYER_DYNAMIC_TTL_MS, async () => {
      const r = await runAfEndpoint("sidelined", { player: String(pid) });
      return arr(r.response).slice(0, 6);
    }).catch(() => [] as unknown[]),
  ]);
  if (!item && !profile) return null;

  const pl = dig(profile, "player") ?? dig(item, "player");
  // 取出场最多的一条联赛统计为主行,其余列为次要
  const stats = arr(dig(item, "statistics"))
    .map((st) => ({
      league: nameZh(String(dig(st, "league", "name") ?? "")),
      team: nameZh(String(dig(st, "team", "name") ?? "")),
      apps: Number(dig(st, "games", "appearences")) || 0,
      minutes: Number(dig(st, "games", "minutes")) || 0,
      goals: Number(dig(st, "goals", "total")) || 0,
      assists: Number(dig(st, "goals", "assists")) || 0,
      yellow: Number(dig(st, "cards", "yellow")) || 0,
      red: Number(dig(st, "cards", "red")) || 0,
      rating: (() => {
        const r = parseFloat(String(dig(st, "games", "rating") ?? ""));
        return Number.isFinite(r) ? r.toFixed(2) : null;
      })(),
      pos: POS_ZH[String(dig(st, "games", "position") ?? "")] ?? String(dig(st, "games", "position") ?? ""),
    }))
    .filter((st) => st.apps > 0)
    .sort((a, b) => b.apps - a.apps)
    .slice(0, 3);

  return {
    ok: true,
    id: pid,
    name: nameZh(String(dig(pl, "name") ?? ""), "player"),
    age: Number(dig(pl, "age")) || null,
    nationality: nameZh(String(dig(pl, "nationality") ?? "")),
    height: String(dig(pl, "height") ?? "") || null,
    weight: String(dig(pl, "weight") ?? "") || null,
    injured: Boolean(dig(pl, "injured")),
    stats,
    seasons: seasons.map((s) => Number(s)).filter(Boolean).sort((a, b) => b - a).slice(0, 8),
    careerTeams: careerTeams.slice(0, 8).map((row) => {
      const ss = arr(dig(row, "seasons")).map((s) => Number(s)).filter(Boolean).sort((a, b) => b - a);
      return {
        id: Number(dig(row, "team", "id")) || null,
        name: nameZh(String(dig(row, "team", "name") ?? "")),
        seasons: ss.slice(0, 4),
      };
    }).filter((r) => r.name),
    sidelined: sidelined.map((sd) => ({
      type: sideZh(String(dig(sd, "type") ?? "")),
      from: String(dig(sd, "start") ?? "").slice(0, 10),
      to: String(dig(sd, "end") ?? "").slice(0, 10) || "至今",
    })),
  };
}
