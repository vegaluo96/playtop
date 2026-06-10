/**
 * 中国竞彩网（sporttery.cn）公开前端接口适配器——零注册零 key 的官方盘口源。
 * 注意：该接口可能对境外 IP 关闭（WAF 403），设置页提供「测试竞彩接口」自检；
 * 不通时采集链路自动降级到 AI 检索盘口。
 * 结构防御：递归扫描 JSON 找"像比赛"的对象，兼容接口字段/层级变动。
 */

const CALC_URL =
  "https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=had,hhad,ttg,crs&channel=c";

/** 竞彩中文队名 → martj42 历史库英文名（世界杯 2026 48 队 + 常见简称变体） */
export const CN_TEAM_EN: Record<string, string> = {
  墨西哥: "Mexico",
  南非: "South Africa",
  韩国: "South Korea",
  捷克: "Czech Republic",
  加拿大: "Canada",
  波黑: "Bosnia and Herzegovina",
  卡塔尔: "Qatar",
  瑞士: "Switzerland",
  巴西: "Brazil",
  摩洛哥: "Morocco",
  海地: "Haiti",
  苏格兰: "Scotland",
  美国: "United States",
  巴拉圭: "Paraguay",
  澳大利亚: "Australia",
  土耳其: "Turkey",
  德国: "Germany",
  库拉索: "Curaçao",
  科特迪瓦: "Ivory Coast",
  厄瓜多尔: "Ecuador",
  荷兰: "Netherlands",
  日本: "Japan",
  瑞典: "Sweden",
  突尼斯: "Tunisia",
  比利时: "Belgium",
  埃及: "Egypt",
  伊朗: "Iran",
  新西兰: "New Zealand",
  西班牙: "Spain",
  佛得角: "Cape Verde",
  沙特阿拉伯: "Saudi Arabia",
  沙特: "Saudi Arabia",
  乌拉圭: "Uruguay",
  法国: "France",
  塞内加尔: "Senegal",
  伊拉克: "Iraq",
  挪威: "Norway",
  阿根廷: "Argentina",
  阿尔及利亚: "Algeria",
  奥地利: "Austria",
  约旦: "Jordan",
  葡萄牙: "Portugal",
  刚果金: "DR Congo",
  刚果民主共和国: "DR Congo",
  民主刚果: "DR Congo",
  乌兹别克斯坦: "Uzbekistan",
  哥伦比亚: "Colombia",
  英格兰: "England",
  克罗地亚: "Croatia",
  加纳: "Ghana",
  巴拿马: "Panama",
};

export interface SportteryMatch {
  homeCn: string;
  awayCn: string;
  /** 映射到历史库英文名；映射不了为 null（非世界杯队伍正常现象） */
  homeEn: string | null;
  awayEn: string | null;
  league: string;
  /** UTC 毫秒（接口为北京时间，已 -8h） */
  kickoffAt: number;
  /** 接口未给开球钟点时为 false，匹配时放宽到同一天 */
  hasTime: boolean;
  oneXTwo: { home: number; draw: number; away: number } | null;
  /** 让球胜平负（三向整数让球，非亚盘） */
  hhad: { line: number; home: number; draw: number; away: number } | null;
  /** 总进球数赔率："0".."6" 与 "7+" */
  totalGoals: Record<string, number> | null;
  /** 波胆（具体比分赔率，"主:客"） */
  correctScores: { score: string; odds: number }[];
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
}

function beijingToUtc(date: string, time: string): { at: number; hasTime: boolean } | null {
  const d = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return null;
  const t = time.match(/(\d{1,2}):(\d{2})/);
  const hh = t ? Number(t[1]) : 12;
  const mi = t ? Number(t[2]) : 0;
  return {
    at: Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hh, mi) - 8 * 3_600_000,
    hasTime: !!t,
  };
}

/** 三向玩法对象（had/hhad 共用结构）→ {home,draw,away} */
function threeWay(v: unknown): { home: number; draw: number; away: number } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const h = num(o.h);
  const d = num(o.d);
  const a = num(o.a);
  return h && d && a ? { home: h, draw: d, away: a } : null;
}

/** 让球线：goalLine 形如 "+1"/"-1"（字符串） */
function hhadOf(v: unknown): SportteryMatch["hhad"] {
  const tw = threeWay(v);
  if (!tw || !v || typeof v !== "object") return null;
  const line = Number(str((v as Record<string, unknown>).goalLine));
  if (!Number.isFinite(line) || line === 0) return null;
  return { line, ...tw };
}

/** 总进球：键 s0..s7（s7 = 7+），防御式扫描 */
function ttgOf(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const m = k.match(/^s(\d)$/);
    const n = num(val);
    if (m && n) out[m[1] === "7" ? "7+" : m[1]] = n;
  }
  return Object.keys(out).length >= 5 ? out : null;
}

/** 波胆：键 "ddff"（如 "0100" = 1:0），含"胜/平/负其他"等非比分键时跳过该键 */
function crsOf(v: unknown): { score: string; odds: number }[] {
  if (!v || typeof v !== "object") return [];
  const out: { score: string; odds: number }[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const m = k.match(/^(\d{2})(\d{2})$/);
    const n = num(val);
    if (m && n) out.push({ score: `${Number(m[1])}:${Number(m[2])}`, odds: n });
  }
  return out;
}

function toMatch(o: Record<string, unknown>): SportteryMatch | null {
  const homeCn = pick(o, ["homeTeamAllName", "hostTeamAllName", "homeTeamAbbName", "hostTeamAbbName"]);
  const awayCn = pick(o, ["awayTeamAllName", "guestTeamAllName", "awayTeamAbbName", "guestTeamAbbName"]);
  const date = pick(o, ["matchDate", "businessDate"]);
  if (!homeCn || !awayCn || !date) return null;
  const ts = beijingToUtc(date, pick(o, ["matchTime", "matchTimeStr"]));
  if (!ts) return null;
  return {
    homeCn,
    awayCn,
    homeEn: CN_TEAM_EN[homeCn] ?? null,
    awayEn: CN_TEAM_EN[awayCn] ?? null,
    league: pick(o, ["leagueAllName", "leagueAbbName", "leagueName"]),
    kickoffAt: ts.at,
    hasTime: ts.hasTime,
    oneXTwo: threeWay(o.had),
    hhad: hhadOf(o.hhad),
    totalGoals: ttgOf(o.ttg),
    correctScores: crsOf(o.crs),
  };
}

/** 递归扫描任意 JSON 结构，抽取全部比赛对象（纯函数，可单测） */
export function parseSportteryJson(text: string): SportteryMatch[] {
  const out: SportteryMatch[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const m = toMatch(o);
    if (m) {
      out.push(m);
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(JSON.parse(text));
  return out;
}

export async function fetchSporttery(): Promise<SportteryMatch[]> {
  const res = await fetch(CALC_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      referer: "https://www.sporttery.cn/",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`竞彩接口 HTTP ${res.status}（境外 IP 可能被拦截）`);
  return parseSportteryJson(await res.text());
}
