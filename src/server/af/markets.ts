/**
 * 扩展玩法解析(/odds 的 bets 全集早已随 odds_raw 落库,此处读时解析,零额外抓取):
 * 双重机会 / 平局退款 / 零封制胜 / 双方进球 / 单双 / 波胆 / 单队进球大小(主/客)/ 赛果+双方进球 /
 * 半场胜平负 / 下半场胜平负 / 进球最多半场 / 半全场 / 半场让球 / 半场大小 / 角球 / 罚牌 /
 * 任意时间进球 / 首位进球者(球员盘,值为球员名,走 nameZh 汉化)。
 * AF 提供的标准玩法尽量全接;每个玩法独立挑书商(Bet365 → 平博 → 首家),不混合两家报价。
 */
import { isValidDecimalOdd } from "./odds-quality";
import { nameZh } from "../views/names";

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
  Equal: "持平", "1st Half": "上半场", "2nd Half": "下半场", "First Half": "上半场", "Second Half": "下半场",
  "Home/Yes": "主胜/进球", "Home/No": "主胜/0封", "Draw/Yes": "平局/进球", "Draw/No": "平局/0封", "Away/Yes": "客胜/进球", "Away/No": "客胜/0封",
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
  player?: boolean; // 球员盘:value 为球员名,走 nameZh(player) 汉化
}

const PICKS: Pick[] = [
  { key: "double", name: "双重机会", re: /^double chance$/i, exclude: /half/i },
  { key: "dnb", name: "平局退款", re: /^draw no bet$/i, exclude: /half/i },
  { key: "win2nil", name: "零封制胜", re: /^win to nil$/i },
  { key: "btts", name: "双方进球", re: /^both teams score$|^both teams to score$/i, exclude: /half/i },
  { key: "oddeven", name: "总进球单双", re: /^odd\/even$/i, exclude: /half/i },
  { key: "exact", name: "波胆(正确比分)", re: /^exact score$|^correct score$/i, exclude: /half/i, max: 9, sortByOdd: true },
  { key: "resBtts", name: "赛果/双方进球", re: /result.*both teams|both teams.*result|1x2.*both teams/i, max: 6 },
  { key: "scorer", name: "任意时间进球", re: /anytime goal.?scorer|goal.?scorer anytime|^anytime scorer$|^to score$/i, player: true, sortByOdd: true, max: 12 },
  { key: "firstScorer", name: "首位进球者", re: /first goal.?scorer|^1st goal.?scorer|^first scorer$/i, player: true, sortByOdd: true, max: 12 },
  { key: "totalHome", name: "主队进球大小", re: /^total - home$/i, withHandicap: true, max: 6 },
  { key: "totalAway", name: "客队进球大小", re: /^total - away$/i, withHandicap: true, max: 6 },
  { key: "fh1x2", name: "半场胜平负", re: /^first half winner$/i },
  { key: "sh1x2", name: "下半场胜平负", re: /^second half winner$|^2nd half winner$/i },
  { key: "highhalf", name: "进球最多半场", re: /^highest scoring half$/i },
  { key: "htft", name: "半全场", re: /^ht\/ft double$|half ?time\/full ?time/i, max: 9 },
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
    let vals = [...(found.bet.values ?? [])].filter((v) => isValidDecimalOdd(parseFloat(v.odd)));
    if (p.sortByOdd) vals.sort((a, b) => parseFloat(a.odd) - parseFloat(b.odd));
    if (p.max) vals = vals.slice(0, p.max);
    const rows: ExtraRow[] = vals.map((v) => {
      const base = p.player ? nameZh(String(v.value), "player") : zh(String(v.value), p.key === "htft");
      const hc = v.handicap != null && v.handicap !== "" ? ` ${v.handicap}` : "";
      // "Over 2.5" 这类 value 自带盘口时不重复拼 handicap
      const label = p.withHandicap && hc && !/\d/.test(base) ? `${base}${hc}` : base;
      return { v: label, odd: parseFloat(v.odd).toFixed(2) };
    });
    if (rows.length > 0) out.push({ key: p.key, name: p.name, bk: found.bm.name ?? "", rows });
  }
  return out;
}
