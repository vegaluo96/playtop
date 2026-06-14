/**
 * 全局搜索:GET /api/search?q=&tz= —— 跨「比赛 / 联赛 / 球员」的统一搜索,全站搜索弹窗共用。
 * 口径与展示层一致(队名/联赛走 nameZh/leagueZh);比赛取近 3 天 + 未来 14 天窗口。
 * 球员:读 player_index(由数据页榜单/阵容抓取顺带入库),命中→球员资料弹层。
 */
import { NextRequest, NextResponse } from "next/server";
import { hhmm } from "@/lib/format";
import { leagueZh } from "@/lib/leagues";
import { scoreSearchFields } from "@/lib/search";
import { fixturesBetween, searchPlayerIndex } from "@/server/af/store";
import { isFinished, isLive } from "@/server/af/schedule";
import { cfgLeagues } from "@/server/platform/config";
import { nameZh } from "@/server/views/names";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const tz = req.nextUrl.searchParams.get("tz") || "UTC+8";
  if (q.length === 0) return NextResponse.json({ ok: true, matches: [], leagues: [], players: [] });
  const now = Date.now();

  // 比赛:近 3 天 + 未来 14 天,按 队名(中文+原名)/联赛/比赛ID 打分
  const matches = fixturesBetween(now - 3 * 86_400_000, now + 14 * 86_400_000)
    .map((f) => {
      const home = nameZh(f.home_name);
      const away = nameZh(f.away_name);
      const league = leagueZh(f.league_id, f.league_name);
      const score = scoreSearchFields(q, [
        { value: home, weight: 4 }, { value: f.home_name, weight: 3 },
        { value: away, weight: 4 }, { value: f.away_name, weight: 3 },
        { value: `${home} ${away}`, weight: 2 },
        { value: league, weight: 1.5 }, { value: f.fixture_id, weight: 2 },
      ]);
      return { score, f, home, away, league };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.kickoff_utc - b.f.kickoff_utc)
    .slice(0, 20)
    .map(({ f, home, away, league }) => ({
      id: f.fixture_id,
      home,
      away,
      league,
      time: hhmm(f.kickoff_utc, tz),
      live: isLive(f.status),
      finished: isFinished(f.status),
    }));

  // 联赛:后台已开启的联赛
  const leagues = cfgLeagues()
    .filter((l) => l.on)
    .map((l) => ({ score: scoreSearchFields(q, [{ value: l.zh, weight: 4 }, { value: leagueZh(l.id, ""), weight: 2 }]), l }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ l }) => ({ id: l.id, zh: l.zh }));

  // 球员:player_index(名字命中);命中→前端开球员资料弹层(需 id+season)
  const players = searchPlayerIndex(q, 12).map((p) => ({
    id: p.player_id,
    name: nameZh(p.name, "player"),
    team: nameZh(p.team_name),
    league: leagueZh(p.league_id, ""),
    season: p.season,
  }));

  return NextResponse.json({ ok: true, matches, leagues, players });
}
