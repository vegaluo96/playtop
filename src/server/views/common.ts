/** 视图层公用:快照序列 → 列表/走势行;概率信封 → 报告摘要 */
import { ahText, ouText } from "@/lib/format";
import type { SnapRow } from "../af/store";

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

export interface MarketCell {
  line: number | null;
  text: string;
  h: number;
  a: number;
  d: number | null;
  hd: number;
  ad: number;
  /** 该市场最近一次真实变化的时间(进入页面时近窗变化也要可见地闪动) */
  chgAt: number | null;
}

/** 序列尾两帧 → 列表单元格(含涨跌方向) */
export function marketCell(series: SnapRow[], market: "ah" | "ou" | "eu"): MarketCell | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const sgn = (a: number, b: number | null | undefined) => (b == null ? 0 : a > b ? 1 : a < b ? -1 : 0);
  const changed =
    !!prev && (last.h !== prev.h || last.a !== prev.a || last.line !== prev.line || (last.d ?? null) !== (prev.d ?? null));
  return {
    line: last.line,
    text: market === "ah" ? ahText(last.line ?? 0) : market === "ou" ? ouText(last.line ?? 0) : "",
    h: last.h,
    a: last.a,
    d: last.d,
    hd: sgn(last.h, prev?.h),
    ad: sgn(last.a, prev?.a),
    chgAt: changed ? last.captured_at : null,
  };
}

export interface PredSummary {
  pH: number;
  pD: number;
  pA: number;
  winnerName: string;
  winnerHome: boolean;
  winDraw: boolean;
  advice: string;
  uoLine: string | null;
  uoText: string | null;
  goalsHome: string | null;
  goalsAway: string | null;
  comparison: Record<string, { home: number; away: number }>;
  formHome: string;
  formAway: string;
  /** AF 字段缺失时由当前指数派生出的方向(前端需降权展示) */
  derived: boolean;
}

/** 指数兜底输入:最新让球/大小主盘(line + 双侧净水) */
export interface OddsHint {
  ah?: { line: number | null; h: number; a: number } | null;
  ou?: { line: number | null; h: number; a: number } | null;
  homeName?: string;
  awayName?: string;
}

const pct = (v: unknown) => {
  const n = parseFloat(String(v ?? "").replace("%", ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** AF /predictions 信封项 → 中文摘要;odds 仅在 AF 缺方向时生成「指数派生观点」,不得混同官方概率方向。 */
export function predSummary(pred: unknown, homeId: number | null, odds?: OddsHint): PredSummary | null {
  if (!pred) return null;
  const p = pred as Record<string, unknown>;
  const pH = pct(dig(p, "predictions", "percent", "home"));
  const pD = pct(dig(p, "predictions", "percent", "draw"));
  const pA = pct(dig(p, "predictions", "percent", "away"));
  let winnerName = String(dig(p, "predictions", "winner", "name") ?? "");
  let winnerId = Number(dig(p, "predictions", "winner", "id")) || null;
  const winDraw = Boolean(dig(p, "predictions", "win_or_draw"));
  const uoRaw = dig(p, "predictions", "under_over");
  let uoLine = uoRaw == null ? null : String(uoRaw);
  let uoTextZh: string | null = null;
  if (uoLine) {
    const v = parseFloat(uoLine);
    uoTextZh = v < 0 ? `小于 ${Math.abs(v)} 球` : `大于 ${Math.abs(v)} 球`;
  }

  // 指数派生观点:AF 模型未给方向时,只把让球方向/大小低水侧作为行情观察,前端需降权展示。
  let derived = false;
  if (!winnerName && odds?.ah && odds.ah.line != null && odds.ah.line !== 0) {
    const homeSide = odds.ah.line > 0;
    winnerName = homeSide ? (odds.homeName ?? "主队") : (odds.awayName ?? "客队");
    winnerId = homeSide ? homeId : null;
    derived = true;
  }
  if (!uoTextZh && odds?.ou && odds.ou.line != null && odds.ou.h !== odds.ou.a) {
    uoTextZh = odds.ou.h < odds.ou.a ? `大于 ${odds.ou.line} 球` : `小于 ${odds.ou.line} 球`;
    uoLine = uoLine ?? String(odds.ou.line);
    derived = true;
  }

  const winPart = winnerName ? (winDraw ? `概率倾向:${winnerName} 或平局` : `概率倾向:${winnerName}`) : "暂无明确方向";
  const body = winnerName && uoTextZh ? `${winPart};进球方向:${uoTextZh}` : winPart;
  const advice = derived ? `指数派生观点:${body}` : body;
  const comparison: Record<string, { home: number; away: number }> = {};
  const compKeys: [string, string][] = [
    ["form", "状态"], ["att", "攻击"], ["def", "防守"], ["poisson_distribution", "泊松"],
    ["h2h", "交锋"], ["goals", "进球"], ["total", "综合"],
  ];
  for (const [k, zh] of compKeys) {
    comparison[zh] = { home: pct(dig(p, "comparison", k, "home")), away: pct(dig(p, "comparison", k, "away")) };
  }
  return {
    pH, pD, pA,
    winnerName,
    winnerHome: winnerId != null && winnerId === homeId,
    winDraw,
    advice,
    uoLine,
    uoText: uoTextZh,
    goalsHome: (dig(p, "predictions", "goals", "home") as string | null) ?? null,
    goalsAway: (dig(p, "predictions", "goals", "away") as string | null) ?? null,
    comparison,
    formHome: String(dig(p, "teams", "home", "league", "form") ?? ""),
    formAway: String(dig(p, "teams", "away", "league", "form") ?? ""),
    derived,
  };
}

/** "WWDLW" → ["胜","胜","平","负","胜"](近 6 场,旧→新) */
export function formZh(form: string, n = 6): string[] {
  const map: Record<string, string> = { W: "胜", D: "平", L: "负" };
  return form
    .split("")
    .filter((c) => map[c])
    .slice(-n)
    .map((c) => map[c]);
}
