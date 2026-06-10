import { politeFetchText, parseCsv } from "./httpCache";

/**
 * football-data.co.uk 免费 CSV 适配器（无需注册/key）。
 * - 历史：/mmz4281/{季}/{联赛代码}.csv —— 赛果 + 收盘赔率 + 射门/角球/牌 + 裁判
 * - 赛程：/fixtures.csv —— 未来赛程 + 各家即时赔率（站方每周多次更新）
 * 列名随年代略有差异，全部按表头名防御性提取。
 */

export interface CsvHistRow {
  div: string;
  playedAt: number;
  homeTeam: string;
  awayTeam: string;
  fthg: number;
  ftag: number;
  hthg: number | null;
  htag: number | null;
  referee: string | null;
  homeShots: number | null;
  awayShots: number | null;
  homeSot: number | null;
  awaySot: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  odds: {
    home: number | null;
    draw: number | null;
    away: number | null;
    over25: number | null;
    under25: number | null;
    ahLine: number | null;
    ahHome: number | null;
    ahAway: number | null;
  };
}

export interface CsvFixtureRow {
  div: string;
  kickoffAt: number;
  homeTeam: string;
  awayTeam: string;
  odds: CsvHistRow["odds"];
}

function lastSundayUtc(year: number, month: number): number {
  // month: 0-based；返回该月最后一个周日 01:00 UTC
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const day = lastDay.getUTCDay();
  const date = lastDay.getUTCDate() - day;
  return Date.UTC(year, month, date, 1, 0, 0);
}

/** 英国时间 → UTC（BST：3 月最后周日 ~ 10 月最后周日） */
function ukToUtc(y: number, m: number, d: number, hh: number, mm: number): number {
  const naive = Date.UTC(y, m, d, hh, mm);
  const bstStart = lastSundayUtc(y, 2);
  const bstEnd = lastSundayUtc(y, 9);
  const isBst = naive >= bstStart && naive < bstEnd;
  return naive - (isBst ? 3_600_000 : 0);
}

function parseUkDate(dateStr: string, timeStr: string | null): number | null {
  const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]) - 1;
  let y = Number(m[3]);
  if (y < 100) y += y > 80 ? 1900 : 2000;
  let hh = 15;
  let mi = 0;
  const t = timeStr?.match(/^(\d{1,2}):(\d{2})$/);
  if (t) {
    hh = Number(t[1]);
    mi = Number(t[2]);
  }
  return ukToUtc(y, mo, d, hh, mi);
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstNum(get: (col: string) => string | undefined, cols: string[]): number | null {
  for (const c of cols) {
    const n = num(get(c));
    if (n !== null) return n;
  }
  return null;
}

function rowsToObjects(text: string): { get: (col: string) => string | undefined; raw: string[] }[] {
  const { header, rows } = parseCsv(text);
  const idx = new Map(header.map((h, i) => [h, i] as const));
  return rows.map((r) => ({
    get: (col: string) => {
      const i = idx.get(col);
      return i === undefined ? undefined : r[i];
    },
    raw: r,
  }));
}

function extractOdds(get: (col: string) => string | undefined): CsvHistRow["odds"] {
  return {
    home: firstNum(get, ["B365H", "PSH", "PH", "AvgH", "BbAvH", "WHH", "MaxH"]),
    draw: firstNum(get, ["B365D", "PSD", "PD", "AvgD", "BbAvD", "WHD", "MaxD"]),
    away: firstNum(get, ["B365A", "PSA", "PA", "AvgA", "BbAvA", "WHA", "MaxA"]),
    over25: firstNum(get, ["B365>2.5", "P>2.5", "Avg>2.5", "BbAv>2.5", "Max>2.5"]),
    under25: firstNum(get, ["B365<2.5", "P<2.5", "Avg<2.5", "BbAv<2.5", "Max<2.5"]),
    ahLine: firstNum(get, ["AHh", "B365AH", "BbAHh", "AHCh"]),
    ahHome: firstNum(get, ["B365AHH", "PAHH", "AvgAHH", "BbAvAHH", "B365CAHH"]),
    ahAway: firstNum(get, ["B365AHA", "PAHA", "AvgAHA", "BbAvAHA", "B365CAHA"]),
  };
}

/** 季节代码：2025-26 赛季 → "2526"；count 个赛季（含当季）从新到旧 */
export function seasonCodes(refTime: number, count: number): string[] {
  const d = new Date(refTime);
  // 欧洲赛季 8 月起：7 月及之前算上一赛季
  let startYear = d.getUTCFullYear();
  if (d.getUTCMonth() < 7) startYear -= 1;
  const codes: string[] = [];
  for (let k = 0; k < count; k++) {
    const y = startYear - k;
    codes.push(`${String(y % 100).padStart(2, "0")}${String((y + 1) % 100).padStart(2, "0")}`);
  }
  return codes;
}

export async function fetchLeagueSeasonCsv(
  csvBase: string,
  leagueCode: string,
  seasonCode: string,
  force = false,
): Promise<{ rows: CsvHistRow[]; changed: boolean }> {
  const url = `${csvBase}/mmz4281/${seasonCode}/${leagueCode}.csv`;
  const { body, changed } = await politeFetchText(url, force);
  const rows: CsvHistRow[] = [];
  for (const { get } of rowsToObjects(body)) {
    const div = get("Div");
    const date = get("Date");
    const home = get("HomeTeam") ?? get("HT");
    const away = get("AwayTeam") ?? get("AT");
    const fthg = num(get("FTHG"));
    const ftag = num(get("FTAG"));
    if (!div || !date || !home || !away || fthg === null || ftag === null) continue;
    const playedAt = parseUkDate(date, get("Time") ?? null);
    if (playedAt === null) continue;
    rows.push({
      div,
      playedAt,
      homeTeam: home,
      awayTeam: away,
      fthg,
      ftag,
      hthg: num(get("HTHG")),
      htag: num(get("HTAG")),
      referee: get("Referee") || null,
      homeShots: num(get("HS")),
      awayShots: num(get("AS")),
      homeSot: num(get("HST")),
      awaySot: num(get("AST")),
      homeCorners: num(get("HC")),
      awayCorners: num(get("AC")),
      odds: extractOdds(get),
    });
  }
  return { rows, changed };
}

export async function fetchFixturesCsv(
  csvBase: string,
  enabledLeagues: string[],
  force = false,
): Promise<{ rows: CsvFixtureRow[]; changed: boolean }> {
  const url = `${csvBase}/fixtures.csv`;
  const { body, changed } = await politeFetchText(url, force);
  const enabled = new Set(enabledLeagues);
  const rows: CsvFixtureRow[] = [];
  for (const { get } of rowsToObjects(body)) {
    const div = get("Div");
    const date = get("Date");
    const home = get("HomeTeam") ?? get("HT");
    const away = get("AwayTeam") ?? get("AT");
    if (!div || !date || !home || !away) continue;
    if (enabled.size > 0 && !enabled.has(div)) continue;
    const kickoffAt = parseUkDate(date, get("Time") ?? null);
    if (kickoffAt === null) continue;
    rows.push({ div, kickoffAt, homeTeam: home, awayTeam: away, odds: extractOdds(get) });
  }
  return { rows, changed };
}

/** 比赛在 CSV 中的稳定外键 */
export function csvExtId(div: string, kickoffAt: number, home: string, away: string): string {
  const d = new Date(kickoffAt).toISOString().slice(0, 10);
  return `${div}|${d}|${home}|${away}`;
}
