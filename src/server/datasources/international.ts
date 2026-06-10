import { politeFetchText, parseCsv } from "./httpCache";

/**
 * 国际赛（国家队）历史赛果：martj42/international_results（GitHub 公开 CSV，无需 key）。
 * 1872 年至今全部国家队正式比赛：date,home_team,away_team,home_score,away_score,
 * tournament,city,country,neutral —— 用于世界杯等国际大赛的 Elo 回放与 DC 拟合。
 */

const RESULTS_URL =
  "https://raw.githubusercontent.com/martj42/international_results/master/results.csv";

export interface IntlResultRow {
  playedAt: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  tournament: string;
  neutral: boolean;
}

export async function fetchInternationalResults(
  sinceYear: number,
  force = false,
): Promise<{ rows: IntlResultRow[]; changed: boolean }> {
  const { body, changed } = await politeFetchText(RESULTS_URL, force);
  const { header, rows } = parseCsv(body);
  const idx = new Map(header.map((h, i) => [h, i] as const));
  const col = (r: string[], name: string) => {
    const i = idx.get(name);
    return i === undefined ? "" : r[i];
  };
  const out: IntlResultRow[] = [];
  for (const r of rows) {
    const date = col(r, "date");
    if (date.slice(0, 4) < String(sinceYear)) continue;
    const hg = Number(col(r, "home_score"));
    const ag = Number(col(r, "away_score"));
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const playedAt = Date.parse(`${date}T15:00:00Z`);
    if (!Number.isFinite(playedAt)) continue;
    out.push({
      playedAt,
      homeTeam: col(r, "home_team"),
      awayTeam: col(r, "away_team"),
      homeGoals: hg,
      awayGoals: ag,
      tournament: col(r, "tournament"),
      neutral: col(r, "neutral").toLowerCase() === "true",
    });
  }
  return { rows: out, changed };
}

/** 国际赛在 leagues 表中的固定代码 */
export const INTERNATIONAL_LEAGUE_CODE = "INT";
