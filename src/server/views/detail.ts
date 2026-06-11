/**
 * 详情页视图模型:matchPanorama → 6 个 tab 的渲染数据(全部中文化)。
 */
import { ahText, f2, hhmm, maskBookmaker, ouText } from "@/lib/format";
import { leagueZh, roundZh } from "@/lib/leagues";
import { freshLine, isFinished, isLive } from "../af/schedule";
import { cfgTierIntervals } from "../platform/config";
import { normalizeLiveOddsItem } from "../af/normalize";
import { liveOddsSeries } from "../af/live-store";
import { compositeLive, compositePre, mergeComposite } from "./composite";
import { nameZh } from "./names";
import { kvCached, kvGet } from "../af/store";
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

/* ── 赔率走势:全序列 → 变盘点行 + 折线采样 ── */
export function seriesRows(series: SnapRow[], market: "ah" | "ou", tz: string) {
  if (series.length === 0) return { rows: [], chart: [] };
  const rows: { t: string; text: string; h: string; a: string; chg: boolean }[] = [];
  let prevLine: number | null = null;
  series.forEach((s, i) => {
    const chg = prevLine != null && s.line !== prevLine;
    const isEdge = i === 0 || i === series.length - 1;
    if (isEdge || chg) {
      rows.push({
        t: hhmm(s.captured_at, tz), // 首帧=本站归档起点,不冒充真实初盘
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
  const pick = series.length > 5 ? [series[0], ...series.slice(-4)] : series;
  return pick.map((s) => ({
    t: hhmm(s.captured_at, tz),
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
  ["Corner Kicks", "角球"],
  ["Fouls", "犯规"],
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

const EVENT_KIND: Record<string, string> = { Goal: "goal", Card: "yellow", subst: "sub", Var: "var" };

function eventsView(bundle: Record<string, unknown>, homeId: number | null) {
  const evs = arr(bundle.events);
  if (evs.length === 0) return null;
  return evs.map((e) => {
    const type = String(dig(e, "type") ?? "");
    const detail = String(dig(e, "detail") ?? "");
    let k = EVENT_KIND[type] ?? "var";
    if (type === "Card" && /red/i.test(detail)) k = "red";
    const player = nameZh(String(dig(e, "player", "name") ?? ""), "player");
    const assist = dig(e, "assist", "name");
    let x = player;
    if (type === "Goal") x = `${player}${assist ? `(助攻:${assist})` : ""}${/penalty/i.test(detail) ? "(点球)" : ""}`;
    else if (type === "subst") x = `${player} ⇄ ${assist ?? ""}`;
    else if (type === "Var") x = `VAR:${detail}`;
    return {
      m: `${dig(e, "time", "elapsed") ?? ""}${dig(e, "time", "extra") ? "+" + dig(e, "time", "extra") : ""}'`,
      s: Number(dig(e, "team", "id")) === homeId ? "主" : "客",
      k,
      x,
    };
  });
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
        d: Number.isFinite(date) ? new Date(date + 8 * 3_600_000).toISOString().slice(2, 10).replace(/-/g, "-") : "",
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
    const pickRow = (teamId: number | null) => table.find((row) => Number(dig(row, "team", "id")) === teamId);
    return [pickRow(homeId), pickRow(awayId)]
      .filter(Boolean)
      .map((row) => ({
        rk: Number(dig(row, "rank")) || 0,
        team: String(dig(row, "team", "name") ?? ""),
        rec: `${dig(row, "all", "win")}胜 ${dig(row, "all", "draw")}平 ${dig(row, "all", "lose")}负`,
        gd: `${Number(dig(row, "goalsDiff")) >= 0 ? "+" : ""}${dig(row, "goalsDiff")}`,
        pts: Number(dig(row, "points")) || 0,
        ha: `主场 ${dig(row, "home", "win")}胜${dig(row, "home", "draw")}平${dig(row, "home", "lose")}负`,
      }));
  } catch {
    return [];
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
/** mirror=true(客队)列序反转:两卡上下排布时同一行左右对应同一路,贴近观赛习惯 */
function lineupSide(lu: unknown, mirror = false) {
  const rowsMap = new Map<number, { col: number; p: LineupPlayer }[]>();
  for (const p of arr(dig(lu, "startXI"))) {
    const grid = String(dig(p, "player", "grid") ?? "");
    const [row, col] = grid.split(":").map(Number);
    const name = String(dig(p, "player", "name") ?? "");
    if (!Number.isFinite(row)) continue;
    if (!rowsMap.has(row)) rowsMap.set(row, []);
    rowsMap.get(row)!.push({
      col: col || 0,
      p: {
        n: nameZh(name, "player"),
        num: (Number(dig(p, "player", "number")) || null) as number | null,
        pos: String(dig(p, "player", "pos") ?? ""),
        id: (Number(dig(p, "player", "id")) || null) as number | null,
      },
    });
  }
  const rows = [...rowsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ps]) => ps.sort((x, y) => (mirror ? y.col - x.col : x.col - y.col)).map((c) => c.p));
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
  return { ready: true as const, home: lineupSide(home), away: lineupSide(away, true) };
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
      x: `${dig(i, "player", "name") ?? ""} · ${dig(i, "player", "reason") ?? "未注明原因"}`,
    };
  });
}

/* ── 深挖 ── */
async function deepView(p: Panorama) {
  if (!p.deep) return null;
  const d = p.deep;
  const fx = p.fixture;
  const statName = (it: unknown) => String(dig(it, "player", "name") ?? "");
  const stat0 = (it: unknown, ...path: (string | number)[]) => dig(arr(dig(it, "statistics"))[0], ...path);
  const lb = [
    { tag: "射手王", tagC: "#e9b949", it: d.topscorers[0], v: (it: unknown) => `${stat0(it, "goals", "total") ?? 0} 球` },
    { tag: "助攻王", tagC: "#5b9dff", it: d.topassists[0], v: (it: unknown) => `${stat0(it, "goals", "assists") ?? 0} 助攻` },
    { tag: "黄牌王", tagC: "#e9b949", it: d.topyellow[0], v: (it: unknown) => `${stat0(it, "cards", "yellow") ?? 0} 黄` },
    { tag: "红牌王", tagC: "var(--red)", it: d.topred[0], v: (it: unknown) => `${stat0(it, "cards", "red") ?? 0} 红` },
  ].map((r) => ({ tag: r.tag, tagC: r.tagC, name: r.it ? statName(r.it) : "—", v: r.it ? r.v(r.it) : "数据积累中" }));

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
        name: String(dig(pl, "player", "name") ?? ""),
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
      for (let page = 1; page <= 2; page++) {
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
        name: String(dig(pl, "player", "name") ?? ""),
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
    return {
      side,
      name: String(dig(c, "name") ?? ""),
      meta: start ? `${start} 上任` : "现任主帅",
      trophies: trophies.length,
    };
  };
  const coaches = [coachView(d.coachHome, d.trophiesHomeCoach, "h"), coachView(d.coachAway, d.trophiesAwayCoach, "a")].filter(
    Boolean,
  ) as { side: string; name: string; meta: string; trophies: number }[];

  const transferView = (list: unknown[], team: string, teamId: number | null) => {
    const last = list
      .flatMap((it) => arr(dig(it, "transfers")).map((tr) => ({ tr, player: dig(it, "player", "name") })))
      .sort((x, y) => Date.parse(String(dig(y.tr, "date") ?? 0)) - Date.parse(String(dig(x.tr, "date") ?? 0)))[0];
    if (!last) return { team, tag: "无变动", x: "近两个转会窗无一线队进出记录" };
    const inbound = Number(dig(last.tr, "teams", "in", "id")) === teamId;
    return {
      team,
      tag: inbound ? "转入" : "转出",
      x: `${last.player}(${String(dig(last.tr, "date") ?? "").slice(0, 10)} · ${dig(last.tr, "type") ?? "转会"})`,
    };
  };
  const transfers = [transferView(d.transfersHome, fx.home_name, fx.home_id), transferView(d.transfersAway, fx.away_name, fx.away_id)];

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
    depthOf(d.squadHome, fx.home_name, await favFormation(fx.home_id)),
    depthOf(d.squadAway, fx.away_name, await favFormation(fx.away_id)),
  ];

  const motiv = coaches.map((c) => `${c.name}:执教生涯冠军 ${c.trophies} 座`);

  const referee = String(dig(p.bundle, "fixture", "referee") ?? "").trim() || null;
  return { lb, venue, referee, scorers, ratings, coaches, transfers, depth, motiv };
}

/* ── 汇总 ── */
export async function detailView(p: Panorama, tz: string, opts: { deep: boolean }) {
  const fx = p.fixture;
  const now = Date.now();
  const live = isLive(fx.status);
  const pred = p.prediction;
  const lastOf = (s: SnapRow[]) => (s.length > 0 ? s[s.length - 1] : null);
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
  // 综合指数:赛前段缓存 60s(盘口慢变),滚球段实时拼接(5s 帧不允许延迟)
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
          ? { mk: "亚盘", v: `${f.line != null ? ahText(f.line) : ""} · ${f2(f.h)} / ${f2(f.a)}`, susp: f.suspended }
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
      iText: market === "ah" ? ahText(c.first.line ?? 0) : ouText(c.first.line ?? 0),
      iW: `${f2(c.first.h)} / ${f2(c.first.a)}`,
      nText: market === "ah" ? ahText(c.last.line ?? 0) : ouText(c.last.line ?? 0),
      nW: `${f2(c.last.h)} / ${f2(c.last.a)}`,
      changed: c.first.line !== c.last.line,
    }));
  const compEu = p.odds.compareEu.map((c) => ({
    co: maskBookmaker(c.bookmaker),
    iW: `${f2(c.first.h)} / ${f2(c.first.d ?? 0)} / ${f2(c.first.a)}`,
    nW: `${f2(c.last.h)} / ${f2(c.last.d ?? 0)} / ${f2(c.last.a)}`,
  }));

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
      fresh: freshLine(fx.kickoff_utc, now, fx.status, cfgTierIntervals()),
    },
    summary: {
      ah: ahL ? { text: ahText(ahL.line ?? 0), w: `${f2(ahL.h)}/${f2(ahL.a)}` } : null,
      ou: ouL ? { text: ouText(ouL.line ?? 0), w: `${f2(ouL.h)}/${f2(ouL.a)}` } : null,
      eu: euL ? { w: `${f2(euL.h)}/${f2(euL.d ?? 0)}/${f2(euL.a)}` } : null,
      oddsAt: Math.max(ahL?.captured_at ?? 0, ouL?.captured_at ?? 0, euL?.captured_at ?? 0) || null,
    },
    liveOdds,
    odds: {
      ah, ou, eu: euRows(euAll, tz),
      euChart: euAll.slice(-40).map((s) => ({ t: hhmm(s.captured_at, tz), h: s.h, a: s.a, d: s.d ?? 0 })),
      index: { ah: await cidx("ah"), ou: await cidx("ou"), eu: await cidx("eu") },
    },
    comp: { ah: compMap(p.odds.compareAh, "ah"), ou: compMap(p.odds.compareOu, "ou"), eu: compEu },
    tech: {
      events: eventsView(p.bundle, fx.home_id),
      stats: liveStats(p.bundle, fx.home_id),
      formHome: ps ? formZh(ps.formHome) : [],
      formAway: ps ? formZh(ps.formAway) : [],
      half: live ? halfStats(fx.fixture_id, fx.home_id) : null,
      h2h: h2hView(await h2hRows(fx.home_id, fx.away_id, pred), fx.home_id, tz),
      minutes: minutesView(pred),
      standings: await standingsView(fx.league_id, fx.season, fx.home_id, fx.away_id),
    },
    lineups: lineupsView(p.bundle, fx.home_id, fx.home_name, fx.away_name),
    intel: intelView(p.injuries, fx.home_id),
    deep: opts.deep ? await deepView(p) : null,
  };
}
