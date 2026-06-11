/** 视图层公用:快照序列 → 列表/走势行;预测信封 → 中文建议 */
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
}

/** 序列尾两帧 → 列表单元格(含涨跌方向) */
export function marketCell(series: SnapRow[], market: "ah" | "ou" | "eu"): MarketCell | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const sgn = (a: number, b: number | null | undefined) => (b == null ? 0 : a > b ? 1 : a < b ? -1 : 0);
  return {
    line: last.line,
    text: market === "ah" ? ahText(last.line ?? 0) : market === "ou" ? ouText(last.line ?? 0) : "",
    h: last.h,
    a: last.a,
    d: last.d,
    hd: sgn(last.h, prev?.h),
    ad: sgn(last.a, prev?.a),
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
}

const pct = (v: unknown) => {
  const n = parseFloat(String(v ?? "").replace("%", ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** AF /predictions 信封项 → 中文摘要(建议文案按设计稿口径合成) */
export function predSummary(pred: unknown, homeId: number | null): PredSummary | null {
  if (!pred) return null;
  const p = pred as Record<string, unknown>;
  const pH = pct(dig(p, "predictions", "percent", "home"));
  const pD = pct(dig(p, "predictions", "percent", "draw"));
  const pA = pct(dig(p, "predictions", "percent", "away"));
  const winnerName = String(dig(p, "predictions", "winner", "name") ?? "");
  const winnerId = Number(dig(p, "predictions", "winner", "id")) || null;
  const winDraw = Boolean(dig(p, "predictions", "win_or_draw"));
  const uoRaw = dig(p, "predictions", "under_over");
  const uoLine = uoRaw == null ? null : String(uoRaw);
  let uoTextZh: string | null = null;
  if (uoLine) {
    const v = parseFloat(uoLine);
    uoTextZh = v < 0 ? `小于 ${Math.abs(v)} 球` : `大于 ${Math.abs(v)} 球`;
  }
  const winPart = winnerName ? (winDraw ? `双重机会:${winnerName} 或平局` : `单场:${winnerName} 胜`) : "样本不足,暂无方向";
  const advice = winnerName && uoTextZh ? `${winPart},且${uoTextZh}` : winPart;
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
