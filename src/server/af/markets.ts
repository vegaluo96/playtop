/**
 * 扩展玩法解析(/odds 的 bets 全集早已随 odds_raw 落库,此处读时解析,零额外抓取):
 * 半场胜平负 / 半全场 / 双重机会 / 双方进球 / 单双 / 波胆 / 半场让球 / 半场大小 / 角球 / 罚牌。
 * 每个玩法独立挑书商:Bet365 → 平博/Pinnacle → 第一家提供该玩法的;不混合两家报价。
 */

interface AfVal {
  value: string | number;
  odd: string;
  handicap?: string | null;
}
interface AfBet {
  id?: number;
  name?: string;
  values?: AfVal[];
}
interface AfBm {
  id?: number;
  name?: string;
  bets?: AfBet[];
}

export interface ExtraRow {
  v: string;
  odd: string;
}
export interface ExtraMarket {
  key: string;
  name: string;
  bk: string; // 报价书商(前台打码展示)
  rows: ExtraRow[];
}

const VAL_ZH: Record<string, string> = {
  Home: "主", Draw: "平", Away: "客", Yes: "是", No: "否", Odd: "单", Even: "双", Over: "大", Under: "小",
  "Home/Draw": "主或平", "Home/Away": "主或客", "Draw/Away": "平或客",
  "Home/Home": "主/主", "Home/Draw ": "主/平", "Draw/Home": "平/主", "Draw/Draw": "平/平",
  "Draw/Away ": "平/客", "Away/Home": "客/主", "Away/Draw": "客/平", "Away/Away": "客/客",
};
const SIDE_ZH: Record<string, string> = { Home: "主", Draw: "平", Away: "客", Over: "大", Under: "小" };
const zh = (v: string, combo = false) => {
  const t = v.trim().replace(/\s+/g, " ");
  // 半全场等组合玩法:"Home/Draw" = 半场主/全场平,必须逐段翻,不能撞双重机会的「主或平」
  if (combo && /^(Home|Draw|Away)\/(Home|Draw|Away)$/.test(t)) {
    const [a, b] = t.split("/");
    return `${SIDE_ZH[a]}/${SIDE_ZH[b]}`;
  }
  if (VAL_ZH[t]) return VAL_ZH[t];
  const sideLine = /^(Home|Draw|Away|Over|Under)\s+([+-]?\d+(?:\.\d+)?)$/.exec(t);
  if (sideLine) return `${SIDE_ZH[sideLine[1]]} ${sideLine[2]}`;
  if (/^(Home|Draw|Away)\/(Home|Draw|Away)$/.test(t)) {
    const [a, b] = t.split("/");
    return `${SIDE_ZH[a]}/${SIDE_ZH[b]}`;
  }
  return t;
};

interface Pick {
  key: string;
  name: string;
  re: RegExp;
  exclude?: RegExp;
  max?: number;
  sortByOdd?: boolean;
  withHandicap?: boolean;
}

const PICKS: Pick[] = [
  { key: "fh1x2", name: "半场胜平负", re: /^first half winner$/i },
  { key: "htft", name: "半全场", re: /^ht\/ft double$|half ?time\/full ?time/i, max: 9 },
  { key: "double", name: "双重机会", re: /^double chance$/i, exclude: /half/i },
  { key: "btts", name: "双方进球", re: /^both teams score$|^both teams to score$/i },
  { key: "oddeven", name: "总进球单双", re: /^odd\/even$/i, exclude: /half/i },
  { key: "exact", name: "波胆(正确比分)", re: /^exact score$|^correct score$/i, exclude: /half/i, max: 9, sortByOdd: true },
  { key: "fhah", name: "半场亚盘", re: /asian handicap.*first half|first half.*asian handicap/i, withHandicap: true, max: 6 },
  { key: "fhou", name: "半场大小", re: /(goals )?over\/under.*(first|1st) half|(first|1st) half.*over\/under/i, withHandicap: true, max: 6 },
  { key: "corners", name: "角球大小", re: /corners over under|total corners|corners over\/under/i, withHandicap: true, max: 6 },
  { key: "cards", name: "罚牌大小", re: /cards over\/under|total cards/i, withHandicap: true, max: 6 },
];

const BM_PRIORITY = [8, 4, 11, 2]; // Bet365, Pinnacle(4?), …;命中失败回退首家

export function parseExtraMarkets(item: unknown): ExtraMarket[] {
  const bms = (((item as { bookmakers?: AfBm[] })?.bookmakers ?? []) as AfBm[]).filter((b) => Array.isArray(b.bets));
  if (bms.length === 0) return [];
  const ordered = [
    ...BM_PRIORITY.map((id) => bms.find((b) => b.id === id)).filter(Boolean),
    ...bms,
  ] as AfBm[];

  const out: ExtraMarket[] = [];
  for (const p of PICKS) {
    let found: { bm: AfBm; bet: AfBet } | null = null;
    for (const bm of ordered) {
      const bet = bm.bets!.find((b) => p.re.test(b.name ?? "") && !(p.exclude && p.exclude.test(b.name ?? "")));
      if (bet && (bet.values?.length ?? 0) > 0) {
        found = { bm, bet };
        break;
      }
    }
    if (!found) continue;
    let vals = [...(found.bet.values ?? [])].filter((v) => parseFloat(v.odd) > 1);
    if (p.sortByOdd) vals.sort((a, b) => parseFloat(a.odd) - parseFloat(b.odd));
    if (p.max) vals = vals.slice(0, p.max);
    const rows: ExtraRow[] = vals.map((v) => {
      const base = zh(String(v.value), p.key === "htft");
      const hc = v.handicap != null && v.handicap !== "" ? ` ${v.handicap}` : "";
      // "Over 2.5" 这类 value 自带盘口时不重复拼 handicap
      const label = p.withHandicap && hc && !/\d/.test(base) ? `${base}${hc}` : base;
      return { v: label, odd: parseFloat(v.odd).toFixed(2) };
    });
    if (rows.length > 0) out.push({ key: p.key, name: p.name, bk: found.bm.name ?? "", rows });
  }
  return out;
}
