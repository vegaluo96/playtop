/** 联赛注册表(AF league_id → 中文名/点色;与 worker FOLLOWED_LEAGUES 对齐) */

export interface LeagueInfo {
  id: number;
  zh: string;
  color: string;
  wc?: boolean;
}

export const LEAGUES: LeagueInfo[] = [
  { id: 39, zh: "英超", color: "#8e6cf0" },
  { id: 140, zh: "西甲", color: "#f2a13b" },
  { id: 78, zh: "德甲", color: "#d4524f" },
  { id: 135, zh: "意甲", color: "#3f8cff" },
  { id: 61, zh: "法甲", color: "#38bdd4" },
  { id: 2, zh: "欧冠", color: "#7aa7ff" },
  { id: 3, zh: "欧联", color: "#e98049" },
  { id: 1, zh: "世界杯", color: "#4ad1a0", wc: true },
];

export function leagueZh(id: number, fallback = ""): string {
  return LEAGUES.find((l) => l.id === id)?.zh ?? fallback;
}

export function leagueColor(id: number): string {
  return LEAGUES.find((l) => l.id === id)?.color ?? "#959ba6";
}

/** AF round 字符串 → 中文("Regular Season - 28" → 第 28 轮;"Group A - 1" → A组 第 1 轮) */
export function roundZh(round: string): string {
  let m = /Regular Season\s*-\s*(\d+)/i.exec(round);
  if (m) return `第 ${m[1]} 轮`;
  m = /Group\s+Stage\s*-\s*(\d+)/i.exec(round);
  if (m) return `小组赛 第 ${m[1]} 轮`;
  if (/^Group\s+Stage$/i.test(round)) return "小组赛";
  m = /Group\s+([A-Z\d]{1,2})\s*-\s*(\d+)/i.exec(round); // 组名仅 1-2 位(A组/B组),防误吞单词
  if (m) return `${m[1].toUpperCase()}组 第 ${m[2]} 轮`;
  const map: Record<string, string> = {
    "Round of 32": "1/16 决赛", "Round of 16": "1/8 决赛", "Quarter-finals": "1/4 决赛",
    "Semi-finals": "半决赛", Final: "决赛", "3rd Place Final": "季军赛",
  };
  return map[round] ?? round;
}
