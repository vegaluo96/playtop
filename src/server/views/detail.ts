/**
 * 详情页视图模型:matchPanorama → 6 个 tab 的渲染数据(全部中文化)。
 */
import { ahText, dateStr, f2, hhmm, maskBookmaker, ouText } from "@/lib/format";
import { leagueZh, roundZh } from "@/lib/leagues";
import { freshLine, isFinished, isLive } from "../af/schedule";
import { cfgTierIntervals } from "../platform/config";
import { normalizeLiveOddsItem } from "../af/normalize";
import { liveOddsSeriesByMarket } from "../af/live-store";
import { compositeLive, compositePre, mergeComposite } from "./composite";
import { nameZh } from "./names";
import { kvCached, kvGet, latestOddsRaw } from "../af/store";
import { parseExtraMarkets } from "../af/markets";
import { synthEventsOf } from "../af/events-synth";
import { matchWeather } from "../platform/weather";
import { euKelly, insightsView, kellyOf, lineTrend, payoutRate } from "./insights";
import { runAfEndpoint } from "../af/catalog";
import type { Panorama } from "../af/panorama";
import { formZh, predSummary } from "./common";
import type { SnapRow } from "../af/store";
import { halfStats, liveStats, timelineView } from "./detail-tech";
import { lineupsView, type LineupsView } from "./detail-lineups";

export { timelineView } from "./detail-tech";

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
    // 多组赛事(世界杯)优先展示双方共同所在组;避免 provider 额外泛化组把同队重复带出。
    const groups = new Set(full.map((r) => r.grp));
    const homeGroups = new Set(full.filter((r) => r.hl === "h").map((r) => r.grp));
    const awayGroups = new Set(full.filter((r) => r.hl === "a").map((r) => r.grp));
    const commonGroups = new Set([...homeGroups].filter((g) => awayGroups.has(g)));
    const myGroups = new Set(full.filter((r) => r.hl).map((r) => r.grp));
    const targetGroups = commonGroups.size > 0 ? commonGroups : myGroups;
    const shown = targetGroups.size > 0 && groups.size > 1 ? full.filter((r) => targetGroups.has(r.grp)) : full;
    const pairBase = shown.length > 0 ? shown : full;
    return { table: shown.slice(0, 24), pair: pairBase.filter((r) => r.hl) };
  } catch {
    return { table: [], pair: [] };
  }
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

async function deepView(p: Panorama, lineups: LineupsView) {
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
  ].filter((b) => b.rows.length > 0);

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
    const [homeRatings, awayRatings] = await Promise.all([seasonRatings(fx.home_id, "h"), seasonRatings(fx.away_id, "a")]);
    ratings = [...homeRatings, ...awayRatings];
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

  const lineupCoach = (side: "h" | "a") => {
    if (!lineups.ready) return null;
    const coach = side === "h" ? lineups.home.coach : lineups.away.coach;
    return coach.trim() ? coach : null;
  };
  const coachView = (c: unknown, trophies: unknown[], side: "h" | "a") => {
    const matchCoach = lineupCoach(side);
    if (!c && !matchCoach) return null;
    const coachName = c ? nameZh(String(dig(c, "name") ?? ""), "coach") : "";
    if (matchCoach && (!coachName || matchCoach !== coachName)) {
      return {
        side,
        name: matchCoach,
        meta: "本场阵容主帅 · 资料待官方返回",
        trophies: null,
      };
    }
    if (!c) return null;
    const job = arr(dig(c, "career")).find((j) => dig(j, "end") == null);
    const start = String(dig(job, "start") ?? "").slice(0, 4);
    const age = Number(dig(c, "age")) || null;
    const nat = String(dig(c, "nationality") ?? "");
    const meta = [start ? `${start} 上任` : "现任主帅", age ? `${age} 岁` : "", nat ? nameZh(nat) : ""].filter(Boolean).join(" · ");
    return {
      side,
      name: coachName,
      meta,
      trophies: trophies.length,
    };
  };
  const coaches = [coachView(d.coachHome, d.trophiesHomeCoach, "h"), coachView(d.coachAway, d.trophiesAwayCoach, "a")].filter(
    Boolean,
  ) as { side: string; name: string; meta: string; trophies: number | null }[];

  const transferView = (list: unknown[], team: string, teamId: number | null) => {
    const unusable = (v: unknown) => /data\s*unavailable|not\s*available|unknown|n\/a|数据不可用|不可用|未知|未公布/i.test(String(v ?? ""));
    const last = list
      .flatMap((it) => {
        const rawPlayer = String(dig(it, "player", "name") ?? "");
        return arr(dig(it, "transfers")).map((tr) => ({ tr, rawPlayer, player: nameZh(rawPlayer, "player") }));
      })
      .filter(({ tr, rawPlayer, player }) => {
        const date = String(dig(tr, "date") ?? "");
        const type = String(dig(tr, "type") ?? "");
        const inId = Number(dig(tr, "teams", "in", "id")) || null;
        const outId = Number(dig(tr, "teams", "out", "id")) || null;
        return /^\d{4}-\d{2}-\d{2}/.test(date) && !unusable(type) && !unusable(rawPlayer) && !unusable(player) && (inId != null || outId != null);
      })
      .sort((x, y) => Date.parse(String(dig(y.tr, "date") ?? 0)) - Date.parse(String(dig(x.tr, "date") ?? 0)))[0];
    if (!last) return { team, tag: "官方未返回", x: "未获取到可用官方转会记录" };
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
  const [homeFormation, awayFormation] = await Promise.all([favFormation(fx.home_id), favFormation(fx.away_id)]);
  const depth = [
    depthOf(d.squadHome, nameZh(fx.home_name), homeFormation),
    depthOf(d.squadAway, nameZh(fx.away_name), awayFormation),
  ];

  const motiv = coaches.map((c) => c.trophies == null ? `${c.name}:荣誉数据待官方返回` : `${c.name}:执教生涯冠军 ${c.trophies} 座`);

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
  const lineups = lineupsView(p.bundle, fx.home_id, fx.home_name, fx.away_name);
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
  const liveByMarket = live || isFinished(fx.status) ? liveOddsSeriesByMarket(fx.fixture_id) : { ah: [], ou: [], eu: [] };
  const liveExt = (mk: "ah" | "ou" | "eu"): SnapRow[] =>
    liveByMarket[mk].length > 0
      ? liveByMarket[mk]
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
  const indexPromise = Promise.all([cidx("ah"), cidx("ou"), cidx("eu")]);
  const h2hPromise = h2hRows(fx.home_id, fx.away_id, pred).then((rows) => h2hView(rows, fx.home_id, tz));
  const standingsPromise = standingsView(fx.league_id, fx.season, fx.home_id, fx.away_id);
  const weatherPromise = matchWeather(String(dig(p.bundle, "fixture", "venue", "city") ?? ""), fx.kickoff_utc);
  const insightsPromise = insightsView(fx);
  const deepPromise = opts.deep ? deepView(p, lineups) : Promise.resolve(null);
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
  const [[idxAh, idxOu, idxEu], h2h, standings, weather, insights, deep] = await Promise.all([
    indexPromise,
    h2hPromise,
    standingsPromise,
    weatherPromise,
    insightsPromise,
    deepPromise,
  ]);

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
      index: { ah: idxAh, ou: idxOu, eu: idxEu },
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
      h2h,
      minutes: minutesView(pred),
      standings,
    },
    markets: (() => {
      const raw = latestOddsRaw(fx.fixture_id);
      return raw ? parseExtraMarkets(raw).map((m) => ({ ...m, bk: maskBookmaker(m.bk) })) : [];
    })(),
    // 开球时刻球场天气(MET Norway,免费官方源;拿不到即 null,前端隐藏,绝不伪造)
    weather,
    // 盘路/同赔/疲劳/角球参考(全部由归档数据推导,kv 缓存 10min)
    insights,
    lineups,
    intel: intelView(p.injuries, fx.home_id),
    deep,
  };
}
