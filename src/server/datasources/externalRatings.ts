import { politeFetchText, parseCsv } from "./httpCache";
import { normName } from "./polymarket";

/**
 * 外部评级源（零 key）：
 * - eloratings.net World.tsv：国家队 Elo（世界杯直接相关）
 * - api.clubelo.com：俱乐部 Elo（CSV：Rank,Club,Country,Level,Elo,From,To）
 * 两者均为第三方独立评级，作为展示/事实维度（不进集成——未经我们校准的模型不计票）。
 */

export interface ExternalRating {
  name: string;
  rating: number;
  rank: number | null;
}

/** eloratings.net TSV 防御解析：逐行找「名字 + 合理 Elo 值」组合 */
export function parseEloRatingsTsv(text: string): ExternalRating[] {
  const out: ExternalRating[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("\t").map((c) => c.trim());
    if (cells.length < 2) continue;
    let name = "";
    let rating: number | null = null;
    let rank: number | null = null;
    for (const c of cells) {
      const n = Number(c);
      if (Number.isFinite(n) && c !== "") {
        if (n >= 800 && n <= 2500 && rating === null) rating = n;
        else if (Number.isInteger(n) && n >= 1 && n <= 400 && rank === null) rank = n;
      } else if (/[A-Za-z]{3,}/.test(c) && c.length > name.length) {
        name = c;
      }
    }
    if (name && rating !== null) out.push({ name, rating, rank });
  }
  return out;
}

export async function fetchEloRatings(force = false): Promise<ExternalRating[]> {
  const { body } = await politeFetchText("https://eloratings.net/World.tsv", force, {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0",
  });
  const rows = parseEloRatingsTsv(body);
  if (rows.length < 50) throw new Error(`eloratings 解析仅 ${rows.length} 行，疑似结构变动`);
  return rows;
}

/** ClubElo 当日 CSV */
export function parseClubEloCsv(text: string): ExternalRating[] {
  const { header, rows } = parseCsv(text);
  const idx = new Map(header.map((h, i) => [h, i] as const));
  const out: ExternalRating[] = [];
  for (const r of rows) {
    const name = r[idx.get("Club") ?? -1] ?? "";
    const elo = Number(r[idx.get("Elo") ?? -1]);
    const rank = Number(r[idx.get("Rank") ?? -1]);
    if (name && Number.isFinite(elo)) out.push({ name, rating: elo, rank: Number.isFinite(rank) ? rank : null });
  }
  return out;
}

export async function fetchClubElo(dateIso: string, force = false): Promise<ExternalRating[]> {
  const { body } = await politeFetchText(`http://api.clubelo.com/${dateIso}`, force);
  const rows = parseClubEloCsv(body);
  if (rows.length < 50) throw new Error(`ClubElo 解析仅 ${rows.length} 行，疑似结构变动`);
  return rows;
}

/** 评级表中按队名（含别名）查找：normName 全等优先，其次互含 */
export function findRating(rows: ExternalRating[], teamNames: string[]): ExternalRating | null {
  const keys = teamNames.map(normName).filter(Boolean);
  let partial: ExternalRating | null = null;
  for (const r of rows) {
    const n = normName(r.name);
    if (keys.some((k) => k === n)) return r;
    if (!partial && keys.some((k) => (n.length >= 5 && k.includes(n)) || (k.length >= 5 && n.includes(k)))) partial = r;
  }
  return partial;
}
