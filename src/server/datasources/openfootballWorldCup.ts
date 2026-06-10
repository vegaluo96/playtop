import { politeFetchText } from "./httpCache";

/**
 * openfootball/worldcup（GitHub 公共领域足球数据库，免 key）：World Cup 2026 赛程。
 * Football.TXT 格式：小组赛 cup.txt + 淘汰赛 cup_finals.txt。
 * 淘汰赛对阵未定时为占位符（W74 / 1E / 3A/B/C/D/F 等），数据方随赛事推进替换为
 * 真实队名——因此定时增量同步即可自动补建淘汰赛对阵。
 */

export const WC_LEAGUE_CODE = "WC2026";
export const WC_YEAR = 2026;

const BASE = "https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa";

/** openfootball 队名 → martj42 历史库队名（已逐一核对 48 队，仅两处不一致） */
export const WC_TEAM_FIX: Record<string, string> = {
  USA: "United States",
  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
};

/** 主办城市 → 国家（未列出的均为美国城市） */
const MEXICO_CITIES = new Set(["Mexico City", "Guadalajara (Zapopan)", "Monterrey (Guadalupe)"]);
const CANADA_CITIES = new Set(["Toronto", "Vancouver"]);
const HOST_TEAM: Record<string, string> = { MX: "Mexico", CA: "Canada", US: "United States" };

export function wcCityCountry(city: string): "MX" | "CA" | "US" {
  if (MEXICO_CITIES.has(city)) return "MX";
  if (CANADA_CITIES.has(city)) return "CA";
  return "US";
}

/**
 * 中立场判定：东道主在本国比赛且列为主队 → 非中立；其余一律中立。
 * （东道主列为客队时不给对手主场优势，按中立处理——宁可低估东道主也不错配。）
 */
export function wcNeutral(homeTeamFixed: string, city: string): boolean {
  return HOST_TEAM[wcCityCountry(city)] !== homeTeamFixed;
}

const ROUND_CN: Record<string, string> = {
  "Round of 32": "32 强",
  "Round of 16": "16 强",
  "Quarter-final": "1/4 决赛",
  "Semi-final": "半决赛",
  "Match for third place": "季军赛",
  Final: "决赛",
};

export function wcRoundCn(round: string): string {
  const g = round.match(/^Group ([A-L])$/);
  if (g) return `${g[1]} 组`;
  return ROUND_CN[round] ?? round;
}

export interface WcFixture {
  /** 原文轮次（Group A / Round of 32 …） */
  round: string;
  /** 淘汰赛官方场次编号；小组赛为 null */
  matchNo: number | null;
  /** UTC 毫秒（已按行内 UTC±X 偏移换算） */
  kickoffAt: number;
  /** 原文队名（未做历史库映射） */
  homeTeam: string;
  awayTeam: string;
  city: string;
  /** 淘汰赛占位（对阵未定，暂不可建赛） */
  pending: boolean;
}

const MONTH_BY_PREFIX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** 「Thu June 11」/「Sun Jun 28」——月份全称或缩写均支持 */
const DATE_RE = /^[A-Z][a-z]{2}\s+([A-Z][a-z]+)\s+(\d{1,2})$/;
/** 「(73) 12:00 UTC-7  2A v 2B  @ Los Angeles (Inglewood)」，场次编号可选 */
const MATCH_RE = /^(?:\((\d+)\)\s+)?(\d{1,2}):(\d{2})\s+UTC([+-]\d{1,2})\s+(.+?)\s+v\s+(.+?)\s+@\s+(.+)$/;

function isPlaceholder(name: string): boolean {
  return /^[123][A-L]$/.test(name) || /^[WL]\d{1,3}$/.test(name) || name.includes("/");
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Football.TXT → 结构化赛程（纯函数，无 IO，可单测） */
export function parseFootballTxt(text: string, year: number): WcFixture[] {
  const out: WcFixture[] = [];
  let round = "";
  let date: { month: number; day: number } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("=")) continue;
    if (line.startsWith("▪")) {
      const h = line.slice(1).trim();
      // 「▪ Matchday 1 | Thu Jun 11」是日历注记；不含 | 的才是轮次标题
      if (!h.includes("|")) round = h;
      continue;
    }
    if (/^Group\s+[A-L]\s*\|/.test(line)) continue; // 分组定义行
    const dm = line.match(DATE_RE);
    if (dm) {
      const month = MONTH_BY_PREFIX[dm[1].slice(0, 3).toLowerCase()];
      if (month !== undefined) date = { month, day: Number(dm[2]) };
      continue;
    }
    const mm = line.match(MATCH_RE);
    if (!mm || !date) continue;
    const [, no, hh, mi, off, home, away, city] = mm;
    const kickoffAt =
      Date.UTC(year, date.month, date.day, Number(hh), Number(mi)) - Number(off) * 3_600_000;
    const h = clean(home);
    const a = clean(away);
    out.push({
      round,
      matchNo: no ? Number(no) : null,
      kickoffAt,
      homeTeam: h,
      awayTeam: a,
      city: clean(city),
      pending: isPlaceholder(h) || isPlaceholder(a),
    });
  }
  return out;
}

export async function fetchWorldCupFixtures(
  force = false,
): Promise<{ fixtures: WcFixture[]; changed: boolean }> {
  const groups = await politeFetchText(`${BASE}/cup.txt`, force);
  const finals = await politeFetchText(`${BASE}/cup_finals.txt`, force);
  return {
    fixtures: [...parseFootballTxt(groups.body, WC_YEAR), ...parseFootballTxt(finals.body, WC_YEAR)],
    changed: groups.changed || finals.changed,
  };
}
