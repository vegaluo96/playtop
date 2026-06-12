/**
 * 详情页视图模型:matchPanorama → 6 个 tab 的渲染数据(全部中文化)。
 */
import { ahText, dateStr, f2, hhmm, maskBookmaker, ouText } from "@/lib/format";
import { leagueZh, roundZh } from "@/lib/leagues";
import { freshLine, isFinished, isLive } from "../af/schedule";
import { cfgTierIntervals } from "../platform/config";
import { normalizeLiveOddsItem } from "../af/normalize";
import { liveOddsSeries } from "../af/live-store";
import { compositeLive, compositePre, mergeComposite } from "./composite";
import { nameZh } from "./names";
import { kvCached, kvGet, latestOddsRaw } from "../af/store";
import { parseExtraMarkets } from "../af/markets";
import { synthEventsOf, type SynthEvent } from "../af/events-synth";
import { matchWeather } from "../platform/weather";
import { euKelly, insightsView, kellyOf, lineTrend, payoutRate } from "./insights";
import { runAfEndpoint } from "../af/catalog";
import type { Panorama } from "../af/panorama";
import { formZh, predSummary } from "./common";
import type { SnapRow } from "../af/store";

const H = 3_600_000;

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/* ── 指数走势:全序列 → 变盘点行 + 折线采样 ── */
/** 序列跨天时时间标注带日期(纯 HH:mm 会显得「时间倒流」) */
function tLabelOf(series: SnapRow[], tz: string): (at: number) => string {
  const spanDay = series.length > 1 && dateStr(series[0].captured_at, tz) !== dateStr(series[series.length - 1].captured_at, tz);
  return (at) => (spanDay ? `${dateStr(at, tz).slice(5)} ${hhmm(at, tz)}` : hhmm(at, tz));
}

export function seriesRows(series: SnapRow[], market: "ah" | "ou", tz: string) {
  if (series.length === 0) return { rows: [], chart: [] };
  const tl = tLabelOf(series, tz);
  const rows: { t: string; text: string; h: string; a: string; chg: boolean }[] = [];
  let prevLine: number | null = null;
  series.forEach((s, i) => {
    const chg = prevLine != null && s.line !== prevLine;
    const isEdge = i === 0 || i === series.length - 1;
    if (isEdge || chg) {
      rows.push({
        t: tl(s.captured_at), // 首帧=本站归档起点,不冒充真实初盘
        text: market === "ah" ? ahText(s.line ?? 0) : ouText(s.line ?? 0),
        h: f2(s.h),
        a: f2(s.a),
        chg,
      });
    }
    prevLine = s.line;
  });
  const capped = rows.length > 8 ? [rows[0], ...rows.slice(-7)] : rows;
  const step = Math.max(1, Math.ceil(series.length / 40));
  const chart = series.filter((_, i) => i % step === 0 || i === series.length - 1).map((s) => ({
    t: hhmm(s.captured_at, tz),
    h: s.h,
    a: s.a,
    chg: false,
  }));
  return { rows: capped, chart, startAt: series[0]?.captured_at ?? null };
}

export function euRows(series: SnapRow[], tz: string) {
  const tl = tLabelOf(series, tz);
  const pick = series.length > 5 ? [series[0], ...series.slice(-4)] : series;
  return pick.map((s) => ({
    t: tl(s.captured_at),
    h: f2(s.h),
    d: f2(s.d ?? 0),
    a: f2(s.a),
  }));
}

/* ── 技术面 ── */
const STAT_ZH: [string, string][] = [
  ["Ball Possession", "控球率"],
  ["expected_goals", "预期进球 xG"],
  ["Total Shots", "射门"],
  ["Shots on Goal", "射正"],
  ["Shots off Goal", "射偏"],
  ["Blocked Shots", "被封堵"],
  ["Shots insidebox", "禁区内射门"],
  ["Shots outsidebox", "禁区外射门"],
  ["Corner Kicks", "角球"],
  ["Offsides", "越位"],
  ["Fouls", "犯规"],
  ["Yellow Cards", "黄牌"],
  ["Red Cards", "红牌"],
  ["Goalkeeper Saves", "门将扑救"],
  ["Total passes", "传球"],
  ["Passes accurate", "传球成功"],
  ["Passes %", "传球成功率"],
];

function liveStats(bundle: Record<string, unknown>, homeId: number | null) {
  const blocks = arr(bundle.statistics);
  if (blocks.length < 2) return null;
  const side = (b: unknown) => (Number(dig(b, "team", "id")) === homeId ? "h" : "a");
  const get = (b: unknown, type: string) => {
    const row = arr(dig(b, "statistics")).find((s) => dig(s, "type") === type);
    const v = row ? dig(row, "value") : null;
    return v == null ? null : String(v);
  };
  const home = blocks.find((b) => side(b) === "h");
  const away = blocks.find((b) => side(b) === "a");
  if (!home || !away) return null;
  return STAT_ZH.map(([type, label]) => {
    const lv = get(home, type) ?? "0";
    const rv = get(away, type) ?? "0";
    const num = (s: string) => parseFloat(s.replace("%", "")) || 0;
    return { label, lv, rv, l: num(lv), r: num(rv) };
  }).filter((row) => row.lv !== "0" || row.rv !== "0");
}

/* ── 比赛直播时间轴:真实事件 + 统计差分合成事件 + 状态节点,双列直播页用 ── */
export interface TimelineRow {
  o: number; // 排序键(分钟 + 补时/100;状态节点带偏移保证夹在正确位置)
  m: string; // 分钟标签 "45+2'";状态节点为空
  side: "h" | "a" | "mid";
  kind: string; // goal|own|pen|yellow|red|sub|var|corner|sot|soff|offside|kickoff|ht|2h|ft
  text: string; // 双列时间轴短文案
  live: string; // 文字直播整句
}

const SYNTH_TL: Record<string, { short: string; unit: string; live: (t: string, seq: number, m: number) => string }> = {
  corner: { short: "角球", unit: "个", live: (t, seq, m) => `第 ${m} 分钟,${t}获得角球,这是他们本场第 ${seq} 个角球。` },
  sot: { short: "射正", unit: "次", live: (t, seq, m) => `第 ${m} 分钟,${t}完成一次射正(本队第 ${seq} 次)。` },
  soff: { short: "射偏", unit: "次", live: (t, seq, m) => `第 ${m} 分钟,${t}射门偏出(本队第 ${seq} 次射偏)。` },
  offside: { short: "越位", unit: "次", live: (t, seq, m) => `第 ${m} 分钟,${t}进攻越位(本队第 ${seq} 次)。` },
};

export function timelineView(
  bundle: Record<string, unknown>,
  fx: { status: string; elapsed: number | null; home_id: number | null; home_name: string; away_name: string; goals_home: number | null; goals_away: number | null },
  synth: SynthEvent[],
) {
  const home = nameZh(fx.home_name);
  const away = nameZh(fx.away_name);
  const teamOf = (s: "h" | "a") => (s === "h" ? home : away);
  const rows: TimelineRow[] = [];

  // ① 真实事件(AF events):进球带实时比分、红黄牌、换人、VAR
  let gh = 0;
  let ga = 0;
  for (const e of arr(bundle.events)) {
    const type = String(dig(e, "type") ?? "");
    const detail = String(dig(e, "detail") ?? "");
    const m = Number(dig(e, "time", "elapsed")) || 0;
    const extra = Number(dig(e, "time", "extra")) || 0;
    const side: "h" | "a" = Number(dig(e, "team", "id")) === fx.home_id ? "h" : "a";
    const player = nameZh(String(dig(e, "player", "name") ?? ""), "player");
    const assistRaw = dig(e, "assist", "name");
    const assist = assistRaw ? nameZh(String(assistRaw), "player") : "";
    const ml = extra > 0 ? `${m}+${extra}'` : `${m}'`;
    const o = m + extra / 100;
    if (type === "Goal" && !/missed/i.test(detail)) {
      if (side === "h") gh++;
      else ga++;
      const tag = /penalty/i.test(detail) ? "(点球)" : /own goal/i.test(detail) ? "(乌龙)" : "";
      rows.push({
        o, m: ml, side, kind: "goal",
        text: `${player}${tag} ${gh}-${ga}`,
        live: `第 ${m} 分钟,进球!${teamOf(side)} ${player} 破门${tag}${assist ? `,${assist} 助攻` : ""},当前比分 ${gh}-${ga}。`,
      });
    } else if (type === "Card") {
      const red = /red/i.test(detail);
      rows.push({
        o, m: ml, side, kind: red ? "red" : "yellow",
        text: player || "—",
        live: `第 ${m} 分钟,${teamOf(side)} ${player} 被出示${red ? "红牌" : "黄牌"}。`,
      });
    } else if (type === "subst") {
      rows.push({
        o, m: ml, side, kind: "sub",
        text: `${player} ⇄ ${assist}`,
        live: `第 ${m} 分钟,${teamOf(side)}进行人员调整:${player} ⇄ ${assist}。`,
      });
    } else if (type === "Var") {
      rows.push({ o, m: ml, side, kind: "var", text: `VAR:${detail}`, live: `第 ${m} 分钟,VAR 介入审核:${detail}。` });
    }
  }

  // ② 合成事件(滚球统计差分):角球/射正/射偏/越位,带本队序号
  for (const s of synth) {
    if (s.side === "mid") continue; // 状态节点下方统一处理(含兜底)
    const t = SYNTH_TL[s.kind];
    if (!t) continue;
    rows.push({
      o: s.m + 0.005,
      m: `${s.m}'`,
      side: s.side,
      kind: s.kind,
      text: s.seq != null ? `${t.short} 第${s.seq}${t.unit}` : t.short,
      live: t.live(teamOf(s.side), s.seq ?? 0, s.m),
    });
  }

  // ③ 状态节点:优先用合成记录(当时比分);中途部署/历史场次由真实状态+半场比分兜底,不虚构
  const nodes = new Map<string, { m: number; score: string | null }>();
  for (const s of synth) if (s.side === "mid") nodes.set(s.kind, { m: s.m, score: s.score ?? null });
  const started = isLive(fx.status) || isFinished(fx.status);
  const hth = dig(bundle, "score", "halftime", "home");
  const htScore = hth != null ? `${hth}-${dig(bundle, "score", "halftime", "away")}` : null;
  const finScore = fx.goals_home != null ? `${fx.goals_home}-${fx.goals_away}` : null;
  if (started && !nodes.has("kickoff")) nodes.set("kickoff", { m: 0, score: "0-0" });
  if (started && fx.status !== "1H" && !nodes.has("ht") && htScore) nodes.set("ht", { m: 45, score: htScore });
  if ((["2H", "ET", "BT", "P"].includes(fx.status) || isFinished(fx.status)) && nodes.has("ht") && !nodes.has("2h"))
    nodes.set("2h", { m: 46, score: nodes.get("ht")!.score });
  if (isFinished(fx.status) && !nodes.has("ft")) nodes.set("ft", { m: fx.elapsed ?? 90, score: finScore });
  const NODE_TXT: Record<string, { o: number; text: (s: string | null) => string; live: (s: string | null) => string }> = {
    kickoff: { o: -1, text: () => "比赛开始", live: () => "比赛正式开始。" },
    ht: { o: 45.98, text: (s) => `中场 ${s ?? ""}`.trim(), live: (s) => `上半场结束${s ? `,半场比分 ${s}` : ""}。` },
    "2h": { o: 45.99, text: () => "下半场", live: () => "下半场比赛开始。" },
    ft: { o: 999, text: (s) => `完场 ${s ?? ""}`.trim(), live: (s) => `全场比赛结束${s ? `,最终比分 ${s}` : ""}。` },
  };
  for (const [kind, n] of nodes) {
    const t = NODE_TXT[kind];
    if (t) rows.push({ o: t.o, m: "", side: "mid", kind, text: t.text(n.score), live: t.live(n.score) });
  }

  rows.sort((a, b) => a.o - b.o).reverse(); // 最新在上,直播阅读习惯

  // 角球数(统计现值,头部「角 5-3」)
  let corners: { h: number; a: number } | null = null;
  const blocks = arr(bundle.statistics);
  if (blocks.length >= 2) {
    const of = (b: unknown) => {
      const row = arr(dig(b, "statistics")).find((s) => dig(s, "type") === "Corner Kicks");
      return Number(dig(row, "value")) || 0;
    };
    const hb = blocks.find((b) => Number(dig(b, "team", "id")) === fx.home_id);
    const ab = blocks.find((b) => Number(dig(b, "team", "id")) !== fx.home_id);
    if (hb && ab) corners = { h: of(hb), a: of(ab) };
  }
  return { rows: rows.slice(0, 200), corners, ht: htScore };
}

function minutesView(pred: Record<string, unknown> | null) {
  if (!pred) return null;
  const slots = ["0-15", "16-30", "31-45", "46-60", "61-75", "76-90"];
  const get = (side: string, slot: string) =>
    parseFloat(String(dig(pred, "teams", side, "league", "goals", "for", "minute", slot, "percentage") ?? "").replace("%", "")) || 0;
  const rows = slots.map((slot) => ({ label: slot, h: Math.round(get("home", slot)), a: Math.round(get("away", slot)) }));
  if (rows.every((r) => r.h === 0 && r.a === 0)) return null;
  let mi = 0;
  rows.forEach((r, i) => {
    if (r.h + r.a > rows[mi].h + rows[mi].a) mi = i;
  });
  return { rows, note: `双方合计进球占比最高时段:${slots[mi]}′(${rows[mi].h + rows[mi].a}%)` };
}

/** 历史交锋:优先 fixtures/headtohead 专用端点(满拉 10 场,12h 缓存),回退 predictions 子集 */
async function h2hRows(homeId: number | null, awayId: number | null, pred: Record<string, unknown> | null): Promise<unknown[]> {
  if (homeId && awayId) {
    try {
      const rows = await kvCached<unknown[]>(`h2h:${homeId}-${awayId}`, 12 * H, async () => {
        const r = await runAfEndpoint("fixtures.headtohead", { h2h: `${homeId}-${awayId}`, last: "10", status: "FT-AET-PEN" });
        return Array.isArray(r.response) ? r.response : [];
      });
      if (rows.length > 0) return rows;
    } catch {
      /* 回退 predictions 子集 */
    }
  }
  return arr(dig(pred, "h2h"));
}

function h2hView(games: unknown[], homeId: number | null, tz: string) {
  return games
    .slice(0, 10)
    .map((g) => {
      const gh = Number(dig(g, "goals", "home"));
      const ga = Number(dig(g, "goals", "away"));
      const curHomeIsHome = Number(dig(g, "teams", "home", "id")) === homeId;
      const my = curHomeIsHome ? gh : ga;
      const op = curHomeIsHome ? ga : gh;
      const date = Date.parse(String(dig(g, "fixture", "date") ?? ""));
      return {
        d: Number.isFinite(date) ? dateStr(date, tz).slice(2) : "", // 按用户时区,不再写死 UTC+8
        c: leagueZh(Number(dig(g, "league", "id")), String(dig(g, "league", "name") ?? "")),
        s: `${gh} - ${ga}`,
        res: my > op ? "胜" : my < op ? "负" : "平",
        ou: gh + ga > 2.5 ? "大" : "小",
      };
    });
}

async function standingsView(leagueId: number, season: number, homeId: number | null, awayId: number | null) {
  try {
    const table = await kvCached<unknown[]>(`lg:${leagueId}:${season}:standings2`, 6 * 3_600_000, async () => {
      const r = await runAfEndpoint("standings", { league: String(leagueId), season: String(season) });
      const groups = arr(dig(arr(r.response)[0], "league", "standings"));
      return groups.flatMap((g) => arr(g)); // 拍平全部小组:世界杯等多组赛事两队可能分属不同组
    });
    const rowOf = (row: unknown) => ({
      rk: Number(dig(row, "rank")) || 0,
      teamId: (Number(dig(row, "team", "id")) || null) as number | null,
      team: nameZh(String(dig(row, "team", "name") ?? "")),
      p: Number(dig(row, "all", "played")) || 0,
      w: Number(dig(row, "all", "win")) || 0,
      dr: Number(dig(row, "all", "draw")) || 0,
      l: Number(dig(row, "all", "lose")) || 0,
      gd: Number(dig(row, "goalsDiff")) || 0,
      pts: Number(dig(row, "points")) || 0,
      hl: Number(dig(row, "team", "id")) === homeId ? "h" : Number(dig(row, "team", "id")) === awayId ? "a" : "",
      grp: String(dig(row, "group") ?? ""),
    });
    const full = table.map(rowOf);
    // 多组赛事(世界杯)只展示两队所在组;联赛展示全表
    const myGroups = new Set(full.filter((r) => r.hl).map((r) => r.grp));
    const shown = myGroups.size > 0 && new Set(full.map((r) => r.grp)).size > 1 ? full.filter((r) => myGroups.has(r.grp)) : full;
    return { table: shown.slice(0, 24), pair: full.filter((r) => r.hl) };
  } catch {
    return { table: [], pair: [] };
  }
}

/** 半场拆分(fixtures/statistics?half=true):AF 返回形态做容错解析,解析不出则隐藏容器 */
function halfStats(fixtureId: number, homeId: number | null) {
  const raw = kvGet(`fx:${fixtureId}:stats_half`);
  if (!raw) return null;
  let blocks: unknown[];
  try {
    blocks = (JSON.parse(raw) as { data: unknown[] }).data ?? [];
  } catch {
    return null;
  }
  const teamOf = (b: unknown) => Number(dig(b, "team", "id"));
  // 半场值提取:value 为对象时尝试常见键;数值场景无半场信息则放弃
  const halfOf = (v: unknown): string | null => {
    if (v == null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    for (const k of ["1h", "halftime", "first_half", "firstHalf", "ht"]) {
      if (o[k] != null) return String(o[k]);
    }
    return null;
  };
  const pick = (teamId: number | null) => {
    const b = blocks.find((x) => teamOf(x) === teamId);
    const out = new Map<string, string>();
    for (const st of Array.isArray(dig(b, "statistics")) ? (dig(b, "statistics") as unknown[]) : []) {
      const h = halfOf(dig(st, "value"));
      if (h != null) out.set(String(dig(st, "type")), h);
    }
    return out;
  };
  const home = pick(homeId);
  const awayId = blocks.map(teamOf).find((id) => id !== homeId) ?? null;
  const away = pick(awayId);
  if (home.size === 0 && away.size === 0) return null;
  const rows = STAT_ZH.map(([type, label]) => ({ label, lv: home.get(type) ?? "—", rv: away.get(type) ?? "—" })).filter(
    (r) => r.lv !== "—" || r.rv !== "—",
  );
  return rows.length > 0 ? rows : null;
}

/* ── 阵容 ── */
interface LineupPlayer {
  n: string;
  num: number | null;
  pos: string;
  id: number | null;
}
/**
 * AF lineup.grid = "行:列":行 1 = 门将,行号沿进攻方向递增;列在行内从 1 递增。
 * 朝向对齐百度体育(中文用户基准):门将在顶、前锋在底 → 行号升序渲染。
 * 列向实测:AF 列 1 对应百度的最右(墨西哥后防 雷耶斯…加莱尔多 与列升序相反)→ 列降序。
 * 主客两卡均为独立单队视图,朝向一致(不做镜像)。无 grid 的球员不丢弃,落入末行兜底。
 */
function lineupSide(lu: unknown) {
  const rowsMap = new Map<number, { col: number; p: LineupPlayer }[]>();
  const noGrid: { col: number; p: LineupPlayer }[] = [];
  arr(dig(lu, "startXI")).forEach((p, idx) => {
    const grid = String(dig(p, "player", "grid") ?? "");
    const [row, col] = grid.split(":").map(Number);
    const player: LineupPlayer = {
      n: nameZh(String(dig(p, "player", "name") ?? ""), "player"),
      num: (Number(dig(p, "player", "number")) || null) as number | null,
      pos: String(dig(p, "player", "pos") ?? ""),
      id: (Number(dig(p, "player", "id")) || null) as number | null,
    };
    if (!Number.isFinite(row)) {
      noGrid.push({ col: idx, p: player }); // 无 grid:保留,按出场序排末行,不让阵型缺人
      return;
    }
    if (!rowsMap.has(row)) rowsMap.set(row, []);
    rowsMap.get(row)!.push({ col: col || 0, p: player });
  });
  // 行号升序:门将在顶、前锋在底(对齐百度);列号降序:AF 列 1 对应最右(实测墨西哥后防与百度比对)
  const rows = [...rowsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ps]) => ps.sort((x, y) => y.col - x.col).map((c) => c.p));
  if (noGrid.length > 0) rows.push(noGrid.sort((x, y) => y.col - x.col).map((c) => c.p));
  const subs: LineupPlayer[] = arr(dig(lu, "substitutes")).map((p) => ({
    n: nameZh(String(dig(p, "player", "name") ?? ""), "player"),
    num: (Number(dig(p, "player", "number")) || null) as number | null,
    pos: String(dig(p, "player", "pos") ?? ""),
    id: (Number(dig(p, "player", "id")) || null) as number | null,
  }));
  return {
    form: String(dig(lu, "formation") ?? ""),
    coach: nameZh(String(dig(lu, "coach", "name") ?? ""), "coach"),
    rows,
    subs,
  };
}

function lineupsView(bundle: Record<string, unknown>, homeId: number | null, homeName = "", awayName = "") {
  const lus = arr(bundle.lineups);
  if (lus.length < 2) return { ready: false as const };
  // 指派优先级:team.id 精确匹配 → 队名匹配;两者都对不上则不展示,绝不按下标猜
  const byId = lus.find((l) => Number(dig(l, "team", "id")) === homeId);
  const byName = lus.find((l) => String(dig(l, "team", "name") ?? "") === homeName);
  const home = byId ?? byName;
  if (!home) return { ready: false as const };
  const away = lus.find((l) => l !== home);
  if (!away) return { ready: false as const };
  const awayOk = Number(dig(away, "team", "id")) !== homeId && String(dig(away, "team", "name") ?? "") !== homeName;
  if (!awayOk) return { ready: false as const };
  void awayName;
  return { ready: true as const, home: lineupSide(home), away: lineupSide(away) };
}

/* ── 情报 ── */
const INJURY_TAG: [RegExp, string][] = [
  [/missing/i, "缺阵"],
  [/questionable|doubtful/i, "存疑"],
];
function intelView(injuries: unknown[], homeId: number | null) {
  return injuries.slice(0, 12).map((i) => {
    const type = String(dig(i, "player", "type") ?? "");
    const tag = INJURY_TAG.find(([re]) => re.test(type))?.[1] ?? "存疑";
    return {
      side: Number(dig(i, "team", "id")) === homeId ? "主" : "客",
      tag,
      x: `${nameZh(String(dig(i, "player", "name") ?? ""), "player")} · ${dig(i, "player", "reason") ?? "未注明原因"}`,
    };
  });
}

/* ── 深挖 ── */
async function deepView(p: Panorama) {
  if (!p.deep) return null;
  const d = p.deep;
  const fx = p.fixture;
  const statName = (it: unknown) => nameZh(String(dig(it, "player", "name") ?? ""), "player");
  const stat0 = (it: unknown, ...path: (string | number)[]) => dig(arr(dig(it, "statistics"))[0], ...path);
  const board = (items: unknown[], v: (it: unknown) => string) =>
    items.slice(0, 5).map((it, i) => ({
      rk: i + 1,
      name: statName(it),
      pid: (Number(dig(it, "player", "id")) || null) as number | null,
      team: nameZh(String(dig(it, "statistics", 0, "team", "name") ?? "")),
      v: v(it),
    }));
  const lb = [
    { tag: "射手榜", tagC: "#00c805", rows: board(d.topscorers, (it) => `${stat0(it, "goals", "total") ?? 0} 球`) },
    { tag: "助攻榜", tagC: "#3f8cff", rows: board(d.topassists, (it) => `${stat0(it, "goals", "assists") ?? 0} 助攻`) },
    { tag: "黄牌榜", tagC: "#f2b84b", rows: board(d.topyellow, (it) => `${stat0(it, "cards", "yellow") ?? 0} 黄`) },
    { tag: "红牌榜", tagC: "var(--red)", rows: board(d.topred, (it) => `${stat0(it, "cards", "red") ?? 0} 红`) },
  ];

  // 球场:fixture payload 自带 venue 名称/城市;容量等取 /venues?id=
  const venueId = Number(dig(p.bundle, "fixture", "venue", "id")) || null;
  let venue: { name: string; city: string; cap: string; surface: string; country: string } = {
    name: String(dig(p.bundle, "fixture", "venue", "name") ?? "—"),
    city: String(dig(p.bundle, "fixture", "venue", "city") ?? ""),
    cap: "—", surface: "—", country: "",
  };
  if (venueId) {
    try {
      const v = await kvCached<unknown>(`venue:${venueId}`, 30 * 86_400_000, async () => {
        const r = await runAfEndpoint("venues", { id: String(venueId) });
        return arr(r.response)[0] ?? null;
      });
      if (v) {
        const capN = Number(dig(v, "capacity"));
        venue = {
          name: String(dig(v, "name") ?? venue.name),
          city: String(dig(v, "city") ?? venue.city),
          cap: capN ? `${(capN / 10_000).toFixed(1)} 万` : "—",
          surface: /grass/i.test(String(dig(v, "surface") ?? "")) ? "天然草" : String(dig(v, "surface") ?? "—"),
          country: String(dig(v, "country") ?? ""),
        };
      }
    } catch {
      /* 留默认 */
    }
  }

  const pred = p.prediction;
  const teamGoals = (side: string) => Number(dig(pred, "teams", side, "league", "goals", "for", "total", "total")) || 0;
  const scorersOf = (teamId: number | null, side: "h" | "a") =>
    d.topscorers
      .filter((it) => Number(dig(it, "statistics", 0, "team", "id")) === teamId)
      .slice(0, 1)
      .map((it) => {
        const goals = Number(stat0(it, "goals", "total")) || 0;
        const total = teamGoals(side === "h" ? "home" : "away");
        const share = total > 0 ? Math.round((goals / total) * 100) : null;
        return { side, name: statName(it), pos: String(stat0(it, "games", "position") ?? ""), goals, share };
      });
  const scorers = [...scorersOf(fx.home_id, "h"), ...scorersOf(fx.away_id, "a")];

  // 评分:滚球 → bundle.players 实时评分;赛前 → /players?team&season 全队赛季评分(回退射手榜)
  const liveRatings = (teamId: number | null, side: "h" | "a") => {
    const blocks = Array.isArray(p.bundle.players) ? (p.bundle.players as unknown[]) : [];
    const team = blocks.find((b) => Number(dig(b, "team", "id")) === teamId);
    return (Array.isArray(dig(team, "players")) ? (dig(team, "players") as unknown[]) : [])
      .map((pl) => ({
        side,
        name: nameZh(String(dig(pl, "player", "name") ?? ""), "player"),
        pos: String(dig(pl, "statistics", 0, "games", "position") ?? "").slice(0, 2).toUpperCase(),
        r: Number(parseFloat(String(dig(pl, "statistics", 0, "games", "rating") ?? ""))) || null,
      }))
      .filter((r) => r.r != null)
      .sort((x, y) => (y.r ?? 0) - (x.r ?? 0))
      .slice(0, 3);
  };
  const seasonRatings = async (teamId: number | null, side: "h" | "a") => {
    if (!teamId) return [];
    const players = await kvCached<unknown[]>(`team:${teamId}:${fx.season}:ratings`, 24 * H, async () => {
      const out: unknown[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await runAfEndpoint("players", { team: String(teamId), season: String(fx.season), page: String(page) });
        const arr2 = Array.isArray(r.response) ? r.response : [];
        out.push(...arr2);
        if (arr2.length === 0 || r.paging.current >= r.paging.total) break;
      }
      return out;
    }).catch(() => [] as unknown[]);
    return players
      .map((pl) => ({
        side,
        name: nameZh(String(dig(pl, "player", "name") ?? ""), "player"),
        pos: String(dig(pl, "statistics", 0, "games", "position") ?? "").slice(0, 2).toUpperCase(),
        r: Number(parseFloat(String(dig(pl, "statistics", 0, "games", "rating") ?? ""))) || null,
        apps: Number(dig(pl, "statistics", 0, "games", "appearences")) || 0,
      }))
      .filter((r) => r.r != null && r.apps >= 3) // 出场太少的评分没有参考意义
      .sort((x, y) => (y.r ?? 0) - (x.r ?? 0))
      .slice(0, 3);
  };
  const isLiveNow = !["NS", "TBD", "PST", "FT", "AET", "PEN", "AWD", "WO", "CANC"].includes(fx.status);
  let ratings = isLiveNow ? [...liveRatings(fx.home_id, "h"), ...liveRatings(fx.away_id, "a")] : [];
  if (ratings.length === 0) {
    ratings = [...(await seasonRatings(fx.home_id, "h")), ...(await seasonRatings(fx.away_id, "a"))];
  }
  if (ratings.length === 0) {
    const fromTop = (teamId: number | null, side: "h" | "a") =>
      d.topscorers
        .filter((it) => Number(dig(it, "statistics", 0, "team", "id")) === teamId)
        .slice(0, 3)
        .map((it) => ({
          side,
          name: statName(it),
          pos: String(stat0(it, "games", "position") ?? "").slice(0, 2).toUpperCase(),
          r: Number(parseFloat(String(stat0(it, "games", "rating") ?? ""))) || null,
        }))
        .filter((r) => r.r != null);
    ratings = [...fromTop(fx.home_id, "h"), ...fromTop(fx.away_id, "a")];
  }

  const coachView = (c: unknown, trophies: unknown[], side: "h" | "a") => {
    if (!c) return null;
    const job = arr(dig(c, "career")).find((j) => dig(j, "end") == null);
    const start = String(dig(job, "start") ?? "").slice(0, 4);
    const age = Number(dig(c, "age")) || null;
    const nat = String(dig(c, "nationality") ?? "");
    const meta = [start ? `${start} 上任` : "现任主帅", age ? `${age} 岁` : "", nat ? nameZh(nat) : ""].filter(Boolean).join(" · ");
    return {
      side,
      name: nameZh(String(dig(c, "name") ?? ""), "coach"),
      meta,
      trophies: trophies.length,
    };
  };
  const coaches = [coachView(d.coachHome, d.trophiesHomeCoach, "h"), coachView(d.coachAway, d.trophiesAwayCoach, "a")].filter(
    Boolean,
  ) as { side: string; name: string; meta: string; trophies: number }[];

  const transferView = (list: unknown[], team: string, teamId: number | null) => {
    const last = list
      .flatMap((it) => arr(dig(it, "transfers")).map((tr) => ({ tr, player: nameZh(String(dig(it, "player", "name") ?? ""), "player") })))
      .sort((x, y) => Date.parse(String(dig(y.tr, "date") ?? 0)) - Date.parse(String(dig(x.tr, "date") ?? 0)))[0];
    if (!last) return { team, tag: "暂无记录", x: "未获取到官方转会记录" };
    const inbound = Number(dig(last.tr, "teams", "in", "id")) === teamId;
    return {
      team,
      tag: inbound ? "转入" : "转出",
      x: `${last.player}(${String(dig(last.tr, "date") ?? "").slice(0, 10)} · ${dig(last.tr, "type") ?? "转会"})`,
    };
  };
  const transfers = [transferView(d.transfersHome, nameZh(fx.home_name), fx.home_id), transferView(d.transfersAway, nameZh(fx.away_name), fx.away_id)];

  const favFormation = async (teamId: number | null) => {
    if (!teamId) return null;
    return kvCached<string | null>(`team:${teamId}:${fx.league_id}:${fx.season}:formation`, 24 * H, async () => {
      const r = await runAfEndpoint("teams.statistics", { league: String(fx.league_id), season: String(fx.season), team: String(teamId) });
      const lineups = arr(dig(r.response, "lineups"));
      const top = lineups.sort((x, y) => Number(dig(y, "played")) - Number(dig(x, "played")))[0];
      return top ? `${dig(top, "formation")}(${dig(top, "played")} 场)` : null;
    }).catch(() => null);
  };
  const depthOf = (squad: unknown, team: string, formation: string | null) => {
    const players = arr(dig(squad, "players"));
    const base = players.length === 0 ? "名单数据积累中" : (() => {
      const ages = players.map((pl) => Number(dig(pl, "age"))).filter(Boolean);
      const avg = ages.length > 0 ? (ages.reduce((s, v) => s + v, 0) / ages.length).toFixed(1) : "—";
      return `一线队 ${players.length} 人 · 平均年龄 ${avg} 岁`;
    })();
    return { team, x: formation ? `${base} · 惯用 ${formation}` : base };
  };
  const depth = [
    depthOf(d.squadHome, nameZh(fx.home_name), await favFormation(fx.home_id)),
    depthOf(d.squadAway, nameZh(fx.away_name), await favFormation(fx.away_id)),
  ];

  const motiv = coaches.map((c) => `${c.name}:执教生涯冠军 ${c.trophies} 座`);

  // 赛季面板:teams.statistics 主客拆分/均进失/零封/连胜(AF 深度数据补齐)
  const panelOf = (st: unknown) => {
    if (!st) return null;
    const n = (...path: (string | number)[]) => Number(dig(st, ...path)) || 0;
    const sN = (...path: (string | number)[]) => String(dig(st, ...path) ?? "");
    return {
      played: n("fixtures", "played", "total"),
      rec: `${n("fixtures", "wins", "total")}胜${n("fixtures", "draws", "total")}平${n("fixtures", "loses", "total")}负`,
      recHome: `主 ${n("fixtures", "wins", "home")}胜${n("fixtures", "draws", "home")}平${n("fixtures", "loses", "home")}负`,
      recAway: `客 ${n("fixtures", "wins", "away")}胜${n("fixtures", "draws", "away")}平${n("fixtures", "loses", "away")}负`,
      gf: sN("goals", "for", "average", "total") || "—",
      ga: sN("goals", "against", "average", "total") || "—",
      clean: n("clean_sheet", "total"),
      streak: n("biggest", "streak", "wins"),
      form: sN("form").slice(-5),
    };
  };
  const seasonPanel = { home: panelOf(d.statsHome), away: panelOf(d.statsAway) };

  const referee = String(dig(p.bundle, "fixture", "referee") ?? "").trim() || null;
  return { lb, venue, referee, scorers, ratings, coaches, transfers, depth, motiv, seasonPanel };
}

/* ── 汇总 ── */
export async function detailView(p: Panorama, tz: string, opts: { deep: boolean }) {
  const fx = p.fixture;
  const now = Date.now();
  const live = isLive(fx.status);
  const pred = p.prediction;
  const lastOf = (s: SnapRow[]) => (s.length > 0 ? s[s.length - 1] : null);
  // 该市场最近真实变化时间(进入页面近窗变化也要闪)
  const chgAtOf = (s: SnapRow[]) => {
    if (s.length < 2) return null;
    const [p2, l2] = [s[s.length - 2], s[s.length - 1]];
    return l2.h !== p2.h || l2.a !== p2.a || l2.line !== p2.line || (l2.d ?? null) !== (p2.d ?? null) ? l2.captured_at : null;
  };
  const hintOf = (s: SnapRow[]) => {
    const r = lastOf(s);
    return r ? { line: r.line, h: r.h, a: r.a } : null;
  };
  // 走势序列 = 赛前书商快照 + 滚球实时帧(归档于 live_odds_snapshots),开赛后图表持续生长
  const liveExt = (mk: "ah" | "ou" | "eu"): SnapRow[] =>
    live || isFinished(fx.status)
      ? liveOddsSeries(fx.fixture_id, mk)
          .filter((r) => !r.suspended)
          .map((r) => ({
            fixture_id: fx.fixture_id, bookmaker_id: 0, bookmaker: "实时盘", market: mk,
            line: r.line, h: r.h, a: r.a, d: r.d, captured_at: r.captured_at,
          }))
      : [];
  const merged = (pre: SnapRow[], mk: "ah" | "ou" | "eu") => [...pre, ...liveExt(mk)].sort((x, y) => x.captured_at - y.captured_at);
  const ahAll = merged(p.odds.ah, "ah");
  const ouAll = merged(p.odds.ou, "ou");
  const euAll = merged(p.odds.eu, "eu");
  const ps = predSummary(pred, fx.home_id, { ah: hintOf(ahAll), ou: hintOf(ouAll), homeName: nameZh(fx.home_name), awayName: nameZh(fx.away_name) });
  // 综合指数:赛前段缓存 60s(指数慢变),滚球段实时拼接(5s 帧不允许延迟)
  const cidx = async (mk: "ah" | "ou" | "eu") => {
    const pre = await kvCached(`cidx:${fx.fixture_id}:${mk}`, 60_000, async () => compositePre(fx.fixture_id, mk, fx.kickoff_utc));
    const liveSeg = live || isFinished(fx.status) ? compositeLive(fx.fixture_id, mk) : [];
    return mergeComposite(pre, liveSeg, mk);
  };
  const ah = seriesRows(ahAll, "ah", tz);
  const ou = seriesRows(ouAll, "ou", tz);
  const ahL = lastOf(ahAll);
  const ouL = lastOf(ouAll);
  const euL = lastOf(euAll);

  // 滚球实时盘(worker 落 kv;解析与归档共用 normalizeLiveOddsItem)
  let liveOdds: { mk: string; v: string; susp: boolean }[] | null = null;
  if (live) {
    try {
      const raw = kvGet(`fx:${fx.fixture_id}:liveodds`);
      const data = raw ? (JSON.parse(raw) as { at: number; data: unknown }).data : null;
      const frames = data ? normalizeLiveOddsItem(data) : [];
      const rowsOut = frames.map((f) =>
        f.market === "ah"
          ? { mk: "让球", v: `${f.line != null ? ahText(f.line) : ""} · ${f2(f.h)} / ${f2(f.a)}`, susp: f.suspended }
          : f.market === "ou"
            ? { mk: "大小", v: `${f.line != null ? `${f.line} 球` : ""} · ${f2(f.h)} / ${f2(f.a)}`, susp: f.suspended }
            : { mk: "胜平负", v: `${f2(f.h)} / ${f2(f.d ?? 0)} / ${f2(f.a)}`, susp: f.suspended },
      );
      liveOdds = rowsOut.length > 0 ? rowsOut : null;
    } catch {
      liveOdds = null;
    }
  }

  // 「首帧」= 本站归档到的第一帧(AF 不提供真正初盘),表头与此对齐,不冒充初盘
  const compMap = (list: Panorama["odds"]["compareAh"], market: "ah" | "ou") =>
    list.map((c) => ({
      co: maskBookmaker(c.bookmaker),
      bid: c.last.bookmaker_id, // 点行查看该公司完整历史报价
      iText: market === "ah" ? ahText(c.first.line ?? 0) : ouText(c.first.line ?? 0),
      iW: `${f2(c.first.h)} / ${f2(c.first.a)}`,
      nText: market === "ah" ? ahText(c.last.line ?? 0) : ouText(c.last.line ?? 0),
      nW: `${f2(c.last.h)} / ${f2(c.last.a)}`,
      changed: c.first.line !== c.last.line,
      waterChanged: c.first.h !== c.last.h || c.first.a !== c.last.a,
      chgAt: c.last.captured_at,
    }));
  // ② 凯利指数 + 离散度(≥3 家才有共识意义);④ 升降盘方向 + 返还率首末对照
  const euMeta = euKelly(p.odds.compareEu.map((c) => c.last));
  const compEu = p.odds.compareEu.map((c) => ({
    co: maskBookmaker(c.bookmaker),
    bid: c.last.bookmaker_id,
    iW: `${f2(c.first.h)} / ${f2(c.first.d ?? 0)} / ${f2(c.first.a)}`,
    nW: `${f2(c.last.h)} / ${f2(c.last.d ?? 0)} / ${f2(c.last.a)}`,
    changed: c.first.h !== c.last.h || c.first.d !== c.last.d || c.first.a !== c.last.a,
    chgAt: c.last.captured_at,
    k: euMeta ? [kellyOf(c.last.h, euMeta.prob.h), kellyOf(c.last.d ?? null, euMeta.prob.d), kellyOf(c.last.a, euMeta.prob.a)] : null,
  }));
  // ah/ou 快照存净水,返还率按欧赔小数(净水+1)计算
  const dec = (s: SnapRow | null) => (s ? { h: s.h + 1, a: s.a + 1 } : null);
  const trendOf = (cmp: Panorama["odds"]["compareAh"], all: SnapRow[]) => ({
    dir: lineTrend(cmp),
    ret0: payoutRate(dec(all[0] ?? null)),
    ret1: payoutRate(dec(lastOf(all))),
  });

  return {
    header: {
      id: fx.fixture_id,
      leagueId: fx.league_id,
      league: leagueZh(fx.league_id, fx.league_name),
      round: roundZh(fx.round),
      home: nameZh(fx.home_name),
      away: nameZh(fx.away_name),
      homeId: fx.home_id,
      awayId: fx.away_id,
      live,
      finished: isFinished(fx.status),
      score: fx.goals_home != null ? `${fx.goals_home}-${fx.goals_away}` : null,
      elapsed: fx.elapsed,
      ht: fx.status === "HT",
      kickoff: fx.kickoff_utc,
      season: fx.season,
      fresh: freshLine(fx.kickoff_utc, now, fx.status, cfgTierIntervals()),
    },
    summary: {
      ah: ahL ? { text: ahText(ahL.line ?? 0), w: `${f2(ahL.h)}/${f2(ahL.a)}`, chgAt: chgAtOf(ahAll) } : null,
      ou: ouL ? { text: ouText(ouL.line ?? 0), w: `${f2(ouL.h)}/${f2(ouL.a)}`, chgAt: chgAtOf(ouAll) } : null,
      eu: euL ? { w: `${f2(euL.h)}/${f2(euL.d ?? 0)}/${f2(euL.a)}`, chgAt: chgAtOf(euAll) } : null,
      oddsAt: Math.max(ahL?.captured_at ?? 0, ouL?.captured_at ?? 0, euL?.captured_at ?? 0) || null,
    },
    liveOdds,
    odds: {
      ah, ou, eu: euRows(euAll, tz),
      euChart: euAll.slice(-40).map((s) => ({ t: hhmm(s.captured_at, tz), h: s.h, a: s.a, d: s.d ?? 0 })),
      index: { ah: await cidx("ah"), ou: await cidx("ou"), eu: await cidx("eu") },
    },
    comp: {
      ah: compMap(p.odds.compareAh, "ah"),
      ou: compMap(p.odds.compareOu, "ou"),
      eu: compEu,
      euMeta: euMeta ? { books: euMeta.books, disp: euMeta.disp, method: euMeta.method } : null,
      trend: { ah: trendOf(p.odds.compareAh, ahAll), ou: trendOf(p.odds.compareOu, ouAll) },
    },
    tech: {
      timeline: live || isFinished(fx.status) ? timelineView(p.bundle, fx, synthEventsOf(fx.fixture_id)) : null,
      stats: liveStats(p.bundle, fx.home_id),
      formHome: ps ? formZh(ps.formHome) : [],
      formAway: ps ? formZh(ps.formAway) : [],
      half: live ? halfStats(fx.fixture_id, fx.home_id) : null,
      h2h: h2hView(await h2hRows(fx.home_id, fx.away_id, pred), fx.home_id, tz),
      minutes: minutesView(pred),
      standings: await standingsView(fx.league_id, fx.season, fx.home_id, fx.away_id),
    },
    markets: (() => {
      const raw = latestOddsRaw(fx.fixture_id);
      return raw ? parseExtraMarkets(raw).map((m) => ({ ...m, bk: maskBookmaker(m.bk) })) : [];
    })(),
    // 开球时刻球场天气(MET Norway,免费官方源;拿不到即 null,前端隐藏,绝不伪造)
    weather: await matchWeather(String(dig(p.bundle, "fixture", "venue", "city") ?? ""), fx.kickoff_utc),
    // 盘路/同赔/疲劳/角球参考(全部由归档数据推导,kv 缓存 10min)
    insights: await insightsView(fx),
    lineups: lineupsView(p.bundle, fx.home_id, fx.home_name, fx.away_name),
    intel: intelView(p.injuries, fx.home_id),
    deep: opts.deep ? await deepView(p) : null,
  };
}
