/**
 * AF /odds 响应归一化:每家书商抽 3 个市场(胜平负/亚盘/大小)的主盘口。
 * - 亚盘 line 符号:正=主让(AF "Home -0.5" → +0.5),负=受让;与设计稿 ahText 一致
 * - ah/ou 水位存净水(十进制赔率 -1,保留 2 位),eu 存十进制赔率
 * - 多 line 时取主盘:两侧净水最均衡(|h-a| 最小)且水位在合理区间
 */

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

const net = (odd: string | number) => Math.round((Number(odd) - 1) * 100) / 100;

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
function parseAh(bet: AfBet, euHint: { h: number; a: number } | null): NormalizedMarket | null {
  const homes: { hcap: number; dec: number }[] = [];
  const aways: { hcap: number; dec: number }[] = [];
  for (const v of bet.values ?? []) {
    const m = /^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)$/.exec(String(v.value).trim());
    if (!m) continue;
    const dec = parseFloat(v.odd);
    if (!Number.isFinite(dec) || dec <= 1) continue;
    (m[1] === "Home" ? homes : aways).push({ hcap: parseFloat(m[2]), dec });
  }
  if (homes.length === 0 || aways.length === 0) return null;

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
  if (chosen.sane.length === 0) return null;
  const main = pickBalanced(chosen.sane.map((p) => ({ line: p.line, h: net(p.decH), a: net(p.decA) })));
  return main ? { market: "ah", line: main.line, h: main.h, a: main.a, d: null } : null;
}

function parseOu(bet: AfBet): NormalizedMarket | null {
  const byLine = new Map<number, { h?: number; a?: number }>();
  for (const v of bet.values ?? []) {
    const m = /^(Over|Under)\s*(\d+(?:\.\d+)?)$/.exec(String(v.value).trim());
    if (!m) continue;
    const dec = parseFloat(v.odd);
    if (!Number.isFinite(dec) || dec <= 1) continue;
    const line = parseFloat(m[2]);
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
  return main ? { market: "ou", line: main.line, h: main.h, a: main.a, d: null } : null;
}

function parseEu(bet: AfBet): NormalizedMarket | null {
  let h: number | undefined, d: number | undefined, a: number | undefined;
  for (const v of bet.values ?? []) {
    const val = String(v.value).trim();
    if (val === "Home") h = parseFloat(v.odd);
    else if (val === "Draw") d = parseFloat(v.odd);
    else if (val === "Away") a = parseFloat(v.odd);
  }
  return h != null && d != null && a != null ? { market: "eu", line: null, h, a, d } : null;
}

/** 一条 /odds response 项(单 fixture)→ 各书商归一化结果 */
export function normalizeOddsItem(item: unknown): BookmakerOdds[] {
  const bms = ((item as { bookmakers?: AfBookmaker[] })?.bookmakers ?? []) as AfBookmaker[];
  const out: BookmakerOdds[] = [];
  for (const bm of bms) {
    const markets: NormalizedMarket[] = [];
    let euHint: { h: number; a: number } | null = null;
    for (const bet of bm.bets ?? []) {
      const name = (bet.name ?? "").toLowerCase();
      if (bet.id === 1 || name === "match winner") {
        const m = parseEu(bet);
        if (m) euHint = { h: m.h, a: m.a };
      }
    }
    for (const bet of bm.bets ?? []) {
      const name = (bet.name ?? "").toLowerCase();
      if (bet.id === 4 || name === "asian handicap") {
        const m = parseAh(bet, euHint);
        if (m) markets.push(m);
      } else if (bet.id === 5 || name === "goals over/under") {
        const m = parseOu(bet);
        if (m) markets.push(m);
      } else if (bet.id === 1 || name === "match winner") {
        const m = parseEu(bet);
        if (m) markets.push(m);
      }
    }
    if (markets.length > 0) out.push({ bookmakerId: bm.id ?? 0, bookmaker: bm.name ?? `#${bm.id}`, markets });
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
