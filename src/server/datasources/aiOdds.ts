import { z } from "zod";
import { chatCompletion } from "../llm/apiyi";
import { now } from "../lib/time";
import type { NormalizedOdds } from "../engine/types";

/**
 * AI 检索盘口（apiyi 联网模型）——零注册的盘口兜底通道（竞彩接口不通/未覆盖时启用）。
 * 数字进引擎前过三道闸：强制 JSON → zod 结构校验 → 赔率区间与隐含概率合理性检查，
 * 任何一道不过整组拒收：宁可缺盘口停在采集中等人工补录，也不让编造的数字进模型。
 */

const aiOddsSchema = z.object({
  found: z.boolean().default(false),
  bookmaker: z.string().default("AI 检索"),
  oneXTwo: z
    .object({ home: z.number(), draw: z.number(), away: z.number() })
    .nullable()
    .default(null),
  ou: z.array(z.object({ line: z.number(), over: z.number(), under: z.number() })).default([]),
  ah: z.array(z.object({ line: z.number(), home: z.number(), away: z.number() })).default([]),
});
export type AiOddsRaw = z.infer<typeof aiOddsSchema>;

const ODDS_MIN = 1.01;
const ODDS_MAX = 60;

const sane = (...xs: number[]) => xs.every((x) => Number.isFinite(x) && x >= ODDS_MIN && x <= ODDS_MAX);
/** 盘口线必须是 0.25 的整数倍（0 / 0.25 / 0.5 / 2.75…），否则视为编造 */
const saneLine = (line: number, lo: number, hi: number) =>
  Number.isFinite(line) && line >= lo && line <= hi && Math.abs(line * 4 - Math.round(line * 4)) < 1e-9;

/** 1X2 隐含概率和（含水位）应落在正规区间，之外视为编造/抄错 */
function saneOneXTwo(o: { home: number; draw: number; away: number }): boolean {
  if (!sane(o.home, o.draw, o.away)) return false;
  const s = 1 / o.home + 1 / o.draw + 1 / o.away;
  return s >= 0.98 && s <= 1.3;
}

function saneTwoWay(a: number, b: number): boolean {
  if (!sane(a, b)) return false;
  const s = 1 / a + 1 / b;
  return s >= 0.98 && s <= 1.18;
}

/** 校验 + 组装归一化 odds payload；1X2 不可信则整组拒收（纯函数，可单测） */
export function buildOddsFromAi(raw: AiOddsRaw, capturedAt: number): NormalizedOdds | null {
  if (!raw.found || !raw.oneXTwo || !saneOneXTwo(raw.oneXTwo)) return null;
  return {
    bookmaker: raw.bookmaker || "AI 检索",
    oneXTwo: raw.oneXTwo,
    ou: raw.ou.filter((x) => saneLine(x.line, 0.5, 6.5) && saneTwoWay(x.over, x.under)),
    ah: raw.ah.filter((x) => saneLine(x.line, -4, 4) && saneTwoWay(x.home, x.away)),
    capturedAt,
  };
}

const MOCK = JSON.stringify({ found: false });

export async function aiRetrieveOdds(match: {
  leagueName: string;
  homeName: string;
  awayName: string;
  kickoffAtIso: string;
  round: string | null;
}): Promise<NormalizedOdds | null> {
  const system = [
    "你是体育数据机构的盘口检索员。请检索指定比赛【当前最新】的博彩公司赔率（欧洲十进制小数格式），",
    "来源任选主流公司（bet365 / Pinnacle / 威廉希尔 / 澳门盘等），以你能核实到的为准。",
    "【铁律】只允许输出你真实检索到的数字：若你的运行环境无法联网检索、或检索不到该场赔率、或对数字没有把握，",
    '必须输出 {"found":false}。严禁凭印象估算、严禁编造。',
    "输出 JSON：",
    `{"found":true,"bookmaker":"来源名","oneXTwo":{"home":主胜,"draw":平局,"away":客胜},`,
    `"ou":[{"line":2.5,"over":大球,"under":小球}],"ah":[{"line":主队让球(主让半球=-0.5),"home":主水位,"away":客水位}]}`,
    "ou/ah 检索不到就给空数组，oneXTwo 是必需项。",
  ].join("\n");
  const user = `比赛：${match.leagueName}${match.round ? ` ${match.round}` : ""}，${match.homeName} vs ${match.awayName}，开球时间（UTC）：${match.kickoffAtIso}。请检索该场当前赔率。`;
  const raw = await chatCompletion({ system, user, json: true, maxTokens: 600, mock: MOCK });
  const parsed = aiOddsSchema.parse(JSON.parse(raw));
  return buildOddsFromAi(parsed, now());
}
