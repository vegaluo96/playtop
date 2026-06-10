import { politeFetchText } from "./httpCache";
import { normName } from "./polymarket";

/**
 * Understat（零 key）：五大联赛球队赛季 xG/xGA——从联赛页 HTML 内嵌的
 * `teamsData = JSON.parse('…')` 中抽取（\xNN 转义）。外部评级展示维度。
 */

export const UNDERSTAT_LEAGUE: Record<string, string> = {
  E0: "EPL",
  SP1: "La_liga",
  I1: "Serie_A",
  D1: "Bundesliga",
  F1: "Ligue_1",
};

export interface TeamXg {
  name: string;
  matches: number;
  xG: number;
  xGA: number;
}

/** 解码 \xNN 转义（understat 把 JSON 塞在单引号字符串里） */
function decodeHexEscapes(s: string): string {
  return s.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function parseUnderstatTeams(html: string): TeamXg[] {
  const m = html.match(/teamsData\s*=\s*JSON\.parse\('([^']+)'\)/);
  if (!m) throw new Error("understat 页面结构变动：未找到 teamsData");
  const data = JSON.parse(decodeHexEscapes(m[1])) as Record<
    string,
    { title?: string; history?: { xG?: number; xGA?: number }[] }
  >;
  const out: TeamXg[] = [];
  for (const t of Object.values(data)) {
    const hist = t.history ?? [];
    if (!t.title || hist.length === 0) continue;
    out.push({
      name: t.title,
      matches: hist.length,
      xG: hist.reduce((a, h) => a + (h.xG ?? 0), 0),
      xGA: hist.reduce((a, h) => a + (h.xGA ?? 0), 0),
    });
  }
  return out;
}

export async function fetchUnderstatXg(leagueCode: string, force = false): Promise<TeamXg[]> {
  const slug = UNDERSTAT_LEAGUE[leagueCode];
  if (!slug) return [];
  const { body } = await politeFetchText(`https://understat.com/league/${slug}`, force, {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0",
  });
  return parseUnderstatTeams(body);
}

export function findTeamXg(rows: TeamXg[], teamNames: string[]): TeamXg | null {
  const keys = teamNames.map(normName).filter(Boolean);
  return rows.find((r) => keys.some((k) => k === normName(r.name) || normName(r.name).includes(k) || k.includes(normName(r.name)))) ?? null;
}
