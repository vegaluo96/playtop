/**
 * 中国竞彩网（sporttery.cn）公开前端接口适配器——零注册零 key 的官方盘口源。
 * 注意：该接口可能对境外 IP 关闭（WAF 403），设置页提供「测试竞彩接口」自检；
 * 不通时采集链路自动降级到 AI 检索盘口。
 * 结构防御：递归扫描 JSON 找"像比赛"的对象，兼容接口字段/层级变动。
 */

const CALC_URL =
  "https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry?poolCode=had,hhad&channel=c";

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

function toMatch(o: Record<string, unknown>): SportteryMatch | null {
  const homeCn = pick(o, ["homeTeamAllName", "hostTeamAllName", "homeTeamAbbName", "hostTeamAbbName"]);
  const awayCn = pick(o, ["awayTeamAllName", "guestTeamAllName", "awayTeamAbbName", "guestTeamAbbName"]);
  const date = pick(o, ["matchDate", "businessDate"]);
  if (!homeCn || !awayCn || !date) return null;
  const ts = beijingToUtc(date, pick(o, ["matchTime", "matchTimeStr"]));
  if (!ts) return null;
  let oneXTwo: SportteryMatch["oneXTwo"] = null;
  const had = o.had;
  if (had && typeof had === "object") {
    const h = num((had as Record<string, unknown>).h);
    const d = num((had as Record<string, unknown>).d);
    const a = num((had as Record<string, unknown>).a);
    if (h && d && a) oneXTwo = { home: h, draw: d, away: a };
  }
  return {
    homeCn,
    awayCn,
    homeEn: CN_TEAM_EN[homeCn] ?? null,
    awayEn: CN_TEAM_EN[awayCn] ?? null,
    league: pick(o, ["leagueAllName", "leagueAbbName", "leagueName"]),
    kickoffAt: ts.at,
    hasTime: ts.hasTime,
    oneXTwo,
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
