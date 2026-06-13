/**
 * AF /odds 响应归一化:每家书商抽 3 个市场(胜平负/亚盘/大小)的主盘口。
 * - 亚盘 line 符号:正=主让(AF "Home -0.5" → +0.5),负=受让;与设计稿 ahText 一致
 * - ah/ou 水位存净水(十进制赔率 -1,保留 2 位),eu 存十进制赔率
 * - 多 line 时取主盘:两侧净水最均衡(|h-a| 最小)且水位在合理区间
 */

import { isDisplayableLiveEuTriplet, isFulltimeResultMarketName, isHalfPeriodMarketName, isValidAhLine, isValidDecimalOdd, isValidEuTriplet, isValidOuLine } from "./odds-quality";
import { dig } from "@/lib/dig";

export interface NormalizedMarket {
  market: "ah" | "ou" | "eu";
  line: number | null;
  h: number;
  a: number;
  d: number | null;
}

export interface BookmakerOdds {
  bookmakerId: number;
  bookmaker: string;
  markets: NormalizedMarket[];
}

interface AfBetValue {
  value: string | number;
  odd: string;
}
interface AfBet {
  id?: number;
  name?: string;
  values?: AfBetValue[];
}
interface AfBookmaker {
  id?: number;
  name?: string;
  bets?: AfBet[];
}

export interface DiagnosticIssueDraft {
  endpoint: "odds" | "odds.live" | "odds.extra";
  fixtureId?: number | null;
  bookmakerId?: number | null;
  betId?: number | null;
  rawValue?: unknown;
  parsedValue?: unknown;
  errorType: string;
  errorReason: string;
  severity?: "info" | "warn" | "error";
}

interface NormalizeOptions {
  fixtureId?: number | null;
  onIssue?: (issue: DiagnosticIssueDraft) => void;
}

function issue(opts: NormalizeOptions | undefined, issue: DiagnosticIssueDraft): void {
  opts?.onIssue?.({ ...issue, fixtureId: issue.fixtureId ?? opts.fixtureId ?? null });
}

const net = (odd: string | number) => Math.round((Number(odd) - 1) * 100) / 100;

function euSide(value: unknown): "h" | "d" | "a" | null {
  const val = String(value ?? "").trim().toLowerCase();
  if (val === "home" || val === "1") return "h";
  if (val === "draw" || val === "x") return "d";
  if (val === "away" || val === "2") return "a";
  return null;
}

function isPrematchEuBet(bet: AfBet): boolean {
  const name = bet.name ?? "";
  return bet.id === 1 || isFulltimeResultMarketName(name) || /^winner$/i.test(name) || /home\/draw\/away/i.test(name);
}

function isPrematchAhBet(bet: AfBet): boolean {
  const name = bet.name ?? "";
  if (isHalfPeriodMarketName(name) || /corner|card|yellow|shot|foul|offside|player/i.test(name)) return false;
  return bet.id === 4 || /^asian handicap$/i.test(name) || /^goal handicap$/i.test(name) || /^handicap$/i.test(name) || /^spread$/i.test(name);
}

function isPrematchOuBet(bet: AfBet): boolean {
  const name = bet.name ?? "";
  if (isHalfPeriodMarketName(name) || /corner|card|yellow|shot|foul|offside|player|team total|home team|away team|total - home|total - away|between|range/i.test(name)) {
    return false;
  }
  return bet.id === 5 || /^goals over\/under$/i.test(name) || /^over\/under$/i.test(name) || /^total goals$/i.test(name) || /^match goals$/i.test(name) || /^totals$/i.test(name);
}

function pickBalanced(pairs: { line: number; h: number; a: number }[]): { line: number; h: number; a: number } | null {
  const sane = pairs.filter((p) => p.h > 0.5 && p.h < 1.2 && p.a > 0.5 && p.a < 1.2);
  const pool = sane.length > 0 ? sane : pairs;
  if (pool.length === 0) return null;
  return pool.reduce((best, p) => (Math.abs(p.h - p.a) < Math.abs(best.h - best.a) ? p : best));
}

/** 两腿隐含概率和(满水率):真实成对盘口 ≈ 1.02–1.15;配错腿立刻偏离 */
export function pairMargin(decH: number, decA: number): number {
  return 1 / decH + 1 / decA;
}
const MARGIN_LO = 1.0;
const MARGIN_HI = 1.18;

interface AhPair {
  line: number;
  decH: number;
  decA: number;
}

/**
 * 亚盘配对(对 AF 两种腿标签格式都正确,数学自证):
 * - 镜像标签:Home -0.5 / Away +0.5     → away 的主视角 line = +hcap
 * - 同号标签:Home -0.5 / Away -0.5     → away 的主视角 line = -hcap
 * 用满水率打分选出正确假设;同分歧义(对称梯子/单档)用同书商 1X2 强弱方向裁决。
 * line 口径:正 = 主让(与 ahText 一致)。
 */
function parseAh(bet: AfBet, euHint: { h: number; a: number } | null, bm: AfBookmaker, opts?: NormalizeOptions): NormalizedMarket | null {
  if (isHalfPeriodMarketName(bet.name ?? "")) {
    issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: bet.name, errorType: "PERIOD_NOT_FT", errorReason: "半场亚盘不能进入全场盘口总览", severity: "info" });
    return null;
  }
  const homes: { hcap: number; dec: number }[] = [];
  const aways: { hcap: number; dec: number }[] = [];
  for (const v of bet.values ?? []) {
    const m = /^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)$/.exec(String(v.value).trim());
    if (!m) {
      issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: v, errorType: "VALUE_PARSE_FAILED", errorReason: "亚盘 value 无法解析为 Home/Away + line" });
      continue;
    }
    const dec = parseFloat(v.odd);
    if (!isValidDecimalOdd(dec)) {
      issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: v, parsedValue: { odd: dec }, errorType: "ODDS_OUT_OF_RANGE", errorReason: "亚盘赔率不在 1.01..30 范围" });
      continue;
    }
    (m[1] === "Home" ? homes : aways).push({ hcap: parseFloat(m[2]), dec });
  }
  if (homes.length === 0 || aways.length === 0) {
    issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: bet.values, errorType: "MISSING_SIDE", errorReason: "亚盘缺少 Home 或 Away 任意一边" });
    return null;
  }

  const build = (awayKey: (hcap: number) => number): AhPair[] => {
    const hMap = new Map<number, number>();
    for (const l of homes) if (!hMap.has(-l.hcap)) hMap.set(-l.hcap, l.dec);
    const pairs: AhPair[] = [];
    for (const l of aways) {
      const key = awayKey(l.hcap);
      const decH = hMap.get(key);
      if (decH != null) pairs.push({ line: key, decH, decA: l.dec });
    }
    return pairs;
  };
  const score = (pairs: AhPair[]) => {
    const sane = pairs.filter((p) => pairMargin(p.decH, p.decA) >= MARGIN_LO && pairMargin(p.decH, p.decA) <= MARGIN_HI);
    const dev = sane.length > 0 ? sane.reduce((s, p) => s + Math.abs(pairMargin(p.decH, p.decA) - 1.06), 0) / sane.length : Infinity;
    return { sane, dev };
  };

  const mirror = score(build((hcap) => hcap));      // Away +0.5 → 主视角 +0.5
  const sameSign = score(build((hcap) => -hcap));   // Away -0.5 → 主视角 +0.5
  let chosen = mirror;
  if (sameSign.sane.length > mirror.sane.length) chosen = sameSign;
  else if (sameSign.sane.length === mirror.sane.length && sameSign.sane.length > 0) {
    // 同分歧义(对称梯子两种假设都自洽):用 1X2 强弱方向裁决——主队是热门则主让(line>0)
    const mLine = pickBalanced(mirror.sane.map((p) => ({ line: p.line, h: net(p.decH), a: net(p.decA) })))?.line ?? 0;
    const sLine = pickBalanced(sameSign.sane.map((p) => ({ line: p.line, h: net(p.decH), a: net(p.decA) })))?.line ?? 0;
    if (euHint && mLine !== sLine) {
      const homeFav = euHint.h < euHint.a;
      const fits = (line: number) => (line === 0 ? true : homeFav ? line > 0 : line < 0);
      if (fits(sLine) && !fits(mLine)) chosen = sameSign;
    } else if (sameSign.dev < mirror.dev) chosen = sameSign;
  }
  const valid = chosen.sane.filter((p) => isValidAhLine(p.line));
  if (valid.length === 0) {
    issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: bet.values, parsedValue: chosen.sane, errorType: "LINE_INVALID", errorReason: "亚盘 line 不是 0.25 单位或超出 -4.5..4.5" });
    return null;
  }
  const main = pickBalanced(valid.map((p) => ({ line: p.line, h: net(p.decH), a: net(p.decA) })));
  return main ? { market: "ah", line: main.line, h: main.h, a: main.a, d: null } : null;
}

function parseOu(bet: AfBet, bm: AfBookmaker, opts?: NormalizeOptions): NormalizedMarket | null {
  if (isHalfPeriodMarketName(bet.name ?? "")) {
    issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: bet.name, errorType: "PERIOD_NOT_FT", errorReason: "半场大小不能进入全场盘口总览", severity: "info" });
    return null;
  }
  const byLine = new Map<number, { h?: number; a?: number }>();
  for (const v of bet.values ?? []) {
    const m = /^(Over|Under)\s*(\d+(?:\.\d+)?)$/.exec(String(v.value).trim());
    if (!m) {
      issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: v, errorType: "VALUE_PARSE_FAILED", errorReason: "大小球 value 无法解析为 Over/Under + line" });
      continue;
    }
    const dec = parseFloat(v.odd);
    if (!isValidDecimalOdd(dec)) {
      issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: v, parsedValue: { odd: dec }, errorType: "ODDS_OUT_OF_RANGE", errorReason: "大小球赔率不在 1.01..30 范围" });
      continue;
    }
    const line = parseFloat(m[2]);
    if (!isValidOuLine(line)) {
      issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: v, parsedValue: { line }, errorType: "LINE_INVALID", errorReason: "大小球 line 不是 0.25 单位或超出 0.5..8.5" });
      continue;
    }
    const slot = byLine.get(line) ?? {};
    if (m[1] === "Over") slot.h = net(dec);
    else slot.a = net(dec);
    byLine.set(line, slot);
  }
  const pairs = [...byLine.entries()]
    .filter(([, s]) => s.h != null && s.a != null)
    .map(([line, s]) => ({ line, h: s.h!, a: s.a! }))
    .filter((p) => {
      const margin = pairMargin(p.h + 1, p.a + 1);
      return margin >= MARGIN_LO && margin <= MARGIN_HI;
    });
  const main = pickBalanced(pairs);
  if (!main && byLine.size > 0) issue(opts, { endpoint: "odds", bookmakerId: bm.id, betId: bet.id, rawValue: bet.values, errorType: "PAIR_INCOMPLETE", errorReason: "大小球没有可通过满水率检查的 Over/Under 配对" });
  return main ? { market: "ou", line: main.line, h: main.h, a: main.a, d: null } : null;
}

function parseEu(bet: AfBet, bm?: AfBookmaker, opts?: NormalizeOptions): NormalizedMarket | null {
  if (isHalfPeriodMarketName(bet.name ?? "")) {
    issue(opts, { endpoint: "odds", bookmakerId: bm?.id, betId: bet.id, rawValue: bet.name, errorType: "PERIOD_NOT_FT", errorReason: "半场胜平负不能进入全场盘口总览", severity: "info" });
    return null;
  }
  let h: number | undefined, d: number | undefined, a: number | undefined;
  for (const v of bet.values ?? []) {
    const side = euSide(v.value);
    if (side === "h") h = parseFloat(v.odd);
    else if (side === "d") d = parseFloat(v.odd);
    else if (side === "a") a = parseFloat(v.odd);
  }
  if (h == null || d == null || a == null) {
    issue(opts, { endpoint: "odds", bookmakerId: bm?.id, betId: bet.id, rawValue: bet.values, errorType: "MISSING_SIDE", errorReason: "胜平负缺少 HOME/DRAW/AWAY 任意一项" });
    return null;
  }
  if (!isValidEuTriplet(h, d, a)) {
    issue(opts, { endpoint: "odds", bookmakerId: bm?.id, betId: bet.id, rawValue: bet.values, parsedValue: { h, d, a }, errorType: "ODDS_OUT_OF_RANGE", errorReason: "胜平负赔率或满水率不在可信范围" });
    return null;
  }
  return { market: "eu", line: null, h, a, d };
}

/** 一条 /odds response 项(单 fixture)→ 各书商归一化结果 */
export function normalizeOddsItem(item: unknown, opts: NormalizeOptions = {}): BookmakerOdds[] {
  const bms = ((item as { bookmakers?: AfBookmaker[] })?.bookmakers ?? []) as AfBookmaker[];
  const out: BookmakerOdds[] = [];
  for (const bm of bms) {
    const markets: NormalizedMarket[] = [];
    let euHint: { h: number; a: number } | null = null;
    for (const bet of bm.bets ?? []) {
      if (isPrematchEuBet(bet)) {
        const m = parseEu(bet, bm, opts);
        if (m) euHint = { h: m.h, a: m.a };
      }
    }
    for (const bet of bm.bets ?? []) {
      if (isPrematchAhBet(bet)) {
        const m = parseAh(bet, euHint, bm, opts);
        if (m) markets.push(m);
      } else if (isPrematchOuBet(bet)) {
        const m = parseOu(bet, bm, opts);
        if (m) markets.push(m);
      } else if (isPrematchEuBet(bet)) {
        const m = parseEu(bet, bm, opts);
        if (m) markets.push(m);
      }
    }
    if (markets.length > 0) out.push({ bookmakerId: bm.id ?? 0, bookmaker: bm.name ?? `#${bm.id}`, markets });
  }
  return out;
}

/* ── 滚球实时盘解析(/odds/live;无书商维度,worker 归档与详情页共用同一套解析)── */

export interface LiveMarketFrame {
  market: "ah" | "ou" | "eu";
  line: number | null; // ah:主让为正;ou:盘口;eu:null
  h: number;
  a: number;
  d: number | null; // 仅 eu
  suspended: boolean;
}

export function normalizeLiveOddsItem(item: unknown, opts: NormalizeOptions = {}): LiveMarketFrame[] {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const odds = arr(dig(item, "odds"));
  const find = (re: RegExp) => odds.find((o) => re.test(String(dig(o, "name") ?? "")) && !isHalfPeriodMarketName(String(dig(o, "name") ?? "")));
  const num = (v: unknown) => parseFloat(String(v ?? ""));
  const out: LiveMarketFrame[] = [];

  /**
   * 两腿配对挑主盘:滚球一个玩法挂十几条线,绝不能取数组首条(那是边缘线)。
   * 规则:按 |handicap| 分组配对(两腿必须同线)→ main 标志只作小幅加分 →
   * 综合水位均衡与满水率合理度选主线,避免把 API 第一条或 main 标记当最终答案。
   */
  const pickMainPair = (vals: unknown[], sideARe: RegExp, sideBRe: RegExp, bet: unknown, marketLabel: string) => {
    interface Leg { odd: number; suspended: boolean; main: boolean; hc: number }
    const byLine = new Map<string, { a?: Leg; b?: Leg; invalidOdd?: boolean }>();
    for (const v of vals) {
      const odd = num(dig(v, "odd"));
      if (!isValidDecimalOdd(odd)) {
        const hcForKey = num(dig(v, "handicap"));
        const keyForInvalid = Number.isFinite(hcForKey) ? String(Math.abs(hcForKey)) : "";
        const slotForInvalid = byLine.get(keyForInvalid) ?? {};
        slotForInvalid.invalidOdd = true;
        byLine.set(keyForInvalid, slotForInvalid);
        issue(opts, { endpoint: "odds.live", betId: Number(dig(bet, "id")) || null, rawValue: v, parsedValue: { odd }, errorType: "ODDS_OUT_OF_RANGE", errorReason: `${marketLabel} 滚球赔率不在 1.01..30 范围` });
        continue;
      }
      const hc = num(dig(v, "handicap"));
      const key = Number.isFinite(hc) ? String(Math.abs(hc)) : "";
      const leg: Leg = { odd, suspended: Boolean(dig(v, "suspended")), main: dig(v, "main") === true, hc: Number.isFinite(hc) ? hc : 0 };
      const slot = byLine.get(key) ?? {};
      const val = String(dig(v, "value"));
      if (sideARe.test(val)) slot.a = slot.a ?? leg;
      else if (sideBRe.test(val)) slot.b = slot.b ?? leg;
      byLine.set(key, slot);
    }
    let best: { a: Leg; b: Leg; bal: number; score: number; main: boolean } | null = null;
    for (const slot of byLine.values()) {
      if (!slot.a || !slot.b) continue;
      const margin = 1 / slot.a.odd + 1 / slot.b.odd;
      if (margin < 1.0 || margin > 1.25) continue; // 满水率自证:配错腿/坏数据直接拒收
      const isMain = slot.a.main || slot.b.main;
      const bal = Math.abs(slot.a.odd - slot.b.odd);
      const score = bal + Math.abs(margin - 1.06) * 2 - (isMain ? 0.08 : 0);
      if (!best || score < best.score) best = { a: slot.a, b: slot.b, bal, score, main: isMain };
    }
    return best;
  };

  const ahO = find(/asian handicap/i);
  if (ahO) {
    const pair = pickMainPair(arr(dig(ahO, "values")), /home/i, /away/i, ahO, "亚盘");
    const line = pair ? -pair.a.hc : null;
    if (pair && line != null && isValidAhLine(line))
      out.push({
        market: "ah",
        line, // AF handicap 为主队受让数 → 取反得主让
        h: Math.round((pair.a.odd - 1) * 100) / 100,
        a: Math.round((pair.b.odd - 1) * 100) / 100,
        d: null,
        suspended: pair.a.suspended || pair.b.suspended,
      });
    else if (pair && line != null)
      issue(opts, { endpoint: "odds.live", betId: Number(dig(ahO, "id")) || null, rawValue: dig(ahO, "values"), parsedValue: { line }, errorType: "LINE_INVALID", errorReason: "滚球亚盘 line 不是 0.25 单位或超出 -4.5..4.5" });
    else issue(opts, { endpoint: "odds.live", betId: Number(dig(ahO, "id")) || null, rawValue: dig(ahO, "values"), errorType: "PAIR_INCOMPLETE", errorReason: "滚球亚盘没有可通过满水率检查的 Home/Away 配对" });
  }
  const ouO = find(/over\/under/i);
  if (ouO) {
    const pair = pickMainPair(arr(dig(ouO, "values")), /over/i, /under/i, ouO, "大小球");
    const line = pair ? Math.abs(pair.a.hc) : null;
    if (pair && line != null && isValidOuLine(line))
      out.push({
        market: "ou",
        line,
        h: Math.round((pair.a.odd - 1) * 100) / 100,
        a: Math.round((pair.b.odd - 1) * 100) / 100,
        d: null,
        suspended: pair.a.suspended || pair.b.suspended,
      });
    else if (pair && line != null)
      issue(opts, { endpoint: "odds.live", betId: Number(dig(ouO, "id")) || null, rawValue: dig(ouO, "values"), parsedValue: { line }, errorType: "LINE_INVALID", errorReason: "滚球大小球 line 不是 0.25 单位或超出 0.5..8.5" });
    else issue(opts, { endpoint: "odds.live", betId: Number(dig(ouO, "id")) || null, rawValue: dig(ouO, "values"), errorType: "PAIR_INCOMPLETE", errorReason: "滚球大小球没有可通过满水率检查的 Over/Under 配对" });
  }
  for (const o of odds) {
    const name = String(dig(o, "name") ?? "");
    if (/1x2/i.test(name) && !isFulltimeResultMarketName(name)) {
      issue(opts, { endpoint: "odds.live", betId: Number(dig(o, "id")) || null, rawValue: name, errorType: "PERIOD_NOT_FT", errorReason: "滚球分钟段 1x2 不能进入全场胜平负" });
    }
  }
  const x12 = odds.find((o) => isFulltimeResultMarketName(String(dig(o, "name") ?? "")));
  if (x12) {
    const vals = arr(dig(x12, "values"));
    const g = (side: "h" | "d" | "a") => vals.find((v) => euSide(dig(v, "value")) === side);
    const h = g("h");
    const dd = g("d");
    const a = g("a");
    if (h && dd && a) {
      const hv = num(dig(h, "odd"));
      const dv = num(dig(dd, "odd"));
      const av = num(dig(a, "odd"));
      if (isDisplayableLiveEuTriplet(hv, dv, av))
        out.push({
          market: "eu",
          line: null,
          h: hv,
          a: av,
          d: dv,
          suspended: [h, dd, a].some((v) => Boolean(dig(v, "suspended"))),
        });
      else
        issue(opts, { endpoint: "odds.live", betId: Number(dig(x12, "id")) || null, rawValue: vals, parsedValue: { h: hv, d: dv, a: av }, errorType: "ODDS_OUT_OF_RANGE", errorReason: "滚球胜平负赔率超过展示阈值或满水率不在可信范围" });
    } else if (x12) {
      issue(opts, { endpoint: "odds.live", betId: Number(dig(x12, "id")) || null, rawValue: vals, errorType: "MISSING_SIDE", errorReason: "滚球胜平负缺少 HOME/DRAW/AWAY 任意一项" });
    }
  }
  return out;
}

/* ── 异动判定(阈值:HANDOFF §3 急变 = 盘口位移 ≥0.25 或水位 |Δ|≥0.05)── */

export const MOVE_WATER_MIN = 0.03; // 低于此幅度的纯水位变化不记异动
export const SEV_LINE = 0.25;
export const SEV_WATER = 0.05;

export interface Movement {
  market: "ah" | "ou";
  type: "升盘" | "降盘" | "水位";
  fromLine: number;
  toLine: number;
  fromH: number;
  toH: number;
  fromA: number;
  toA: number;
  sev: boolean;
}

export function detectMovement(
  market: "ah" | "ou",
  prev: { line: number; h: number; a: number },
  next: { line: number; h: number; a: number },
): Movement | null {
  const lineDelta = next.line - prev.line;
  const waterDelta = Math.max(Math.abs(next.h - prev.h), Math.abs(next.a - prev.a));
  let type: Movement["type"];
  if (lineDelta !== 0) type = lineDelta > 0 ? "升盘" : "降盘";
  else if (waterDelta >= MOVE_WATER_MIN) type = "水位";
  else return null;
  const sev = Math.abs(lineDelta) >= SEV_LINE || waterDelta >= SEV_WATER;
  return {
    market, type, sev,
    fromLine: prev.line, toLine: next.line,
    fromH: prev.h, toH: next.h, fromA: prev.a, toA: next.a,
  };
}
