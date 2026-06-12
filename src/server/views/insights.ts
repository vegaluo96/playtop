/**
 * 指数洞察:全部由已归档真实数据推导,无任何虚构。
 *   ① 盘路榜:本站归档的临场盘(收盘前最后一帧)× 官方比分 → 赢/走/输、大/小
 *   ② 凯利指数 + 离散度:多书商胜平负 → 单家公司报价 × 全市场去水概率均值;报价标准差
 *   ③ 同赔历史:初盘胜平负三元组(±0.03)匹配本站归档完场赛事 → 胜平负分布
 *   ④ 升降盘统计 + 返还率趋势:各书商首帧 vs 即时盘方向;主源返还率首末对照
 *   ⑤ 疲劳/赛程密度:距上场天数 + 未来 7 天赛程数(仅统计本站收录赛事)
 *   ⑥ 角球参考:两队近 6 场归档统计的场均角球合计 vs 角球玩法指数
 * 覆盖范围 = 本站归档数据(开赛前 14 天起持续归档),如实标注,随时间自然变厚。
 */
import { db } from "../db";
import { isFinished } from "../af/schedule";
import { kvCached, oddsSeries, type FixtureRow, type SnapRow } from "../af/store";
import { ahText, f2, ouText } from "@/lib/format";
import { nameZh } from "./names";

const DAY = 86_400_000;
const EPS = 1e-9;

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

/* ── ① 盘路榜 ── */

export interface RoadRow {
  d: string; // MM-DD
  opp: string;
  ha: "主" | "客";
  score: string;
  line: string;
  res: string; // 赢|赢半|走|输半|输 / 大|大半|走|小半|小
}
export interface RoadAgg {
  n: number;
  win: number; // 含半赢
  push: number;
  lose: number; // 含半输
  rate: number | null; // 赢盘率/大球率,走盘剔除;无有效场次为 null
  streak: string; // 连赢3 / 连输2 / —
}

/** 让球盘按队伍视角分类:teamDiff = 球队让球后净胜 */
export function ahResult(teamDiff: number): string {
  if (teamDiff > 0.25 + EPS) return "赢";
  if (Math.abs(teamDiff - 0.25) < EPS) return "赢半";
  if (Math.abs(teamDiff) < EPS) return "走";
  if (Math.abs(teamDiff + 0.25) < EPS) return "输半";
  return "输";
}
export function ouResult(diff: number): string {
  if (diff > 0.25 + EPS) return "大";
  if (Math.abs(diff - 0.25) < EPS) return "大半";
  if (Math.abs(diff) < EPS) return "走";
  if (Math.abs(diff + 0.25) < EPS) return "小半";
  return "小";
}

function aggRoad(rows: RoadRow[], winSet: string[], loseSet: string[]): RoadAgg {
  const grp = (res: string) => (winSet.includes(res) ? "w" : loseSet.includes(res) ? "l" : "p");
  const win = rows.filter((r) => grp(r.res) === "w").length;
  const lose = rows.filter((r) => grp(r.res) === "l").length;
  const push = rows.length - win - lose;
  let streak = "—";
  if (rows.length > 0) {
    const g0 = grp(rows[0].res);
    let k = 0;
    while (k < rows.length && grp(rows[k].res) === g0) k++;
    if (g0 !== "p" && k >= 2) streak = `${g0 === "w" ? (winSet[0] === "赢" ? "连赢" : "连大") : winSet[0] === "赢" ? "连输" : "连小"}${k}`;
  }
  return { n: rows.length, win, push, lose, rate: win + lose > 0 ? Math.round((win / (win + lose)) * 100) : null, streak };
}

function teamFinished(teamId: number, beforeUtc: number, lim = 24): FixtureRow[] {
  return (
    db()
      .prepare(
        "SELECT * FROM fixtures_cache WHERE (home_id = ? OR away_id = ?) AND kickoff_utc < ? ORDER BY kickoff_utc DESC LIMIT ?",
      )
      .all(teamId, teamId, beforeUtc, lim) as unknown as FixtureRow[]
  ).filter((f) => isFinished(f.status) && f.goals_home != null && f.goals_away != null);
}

/** 收盘帧 = 该市场归档序列最后一帧(完场赛事的最后一帧即临场盘) */
function closing(fixtureId: number, market: "ah" | "ou"): SnapRow | null {
  const s = oddsSeries(fixtureId, market);
  return s.length > 0 ? s[s.length - 1] : null;
}

export function teamRoad(teamId: number | null, beforeUtc: number, n = 10) {
  const empty = { rows: [] as RoadRow[], agg: aggRoad([], ["赢"], ["输"]) };
  if (!teamId) return { ah: empty, ou: { rows: [] as RoadRow[], agg: aggRoad([], ["大"], ["小"]) } };
  const ahRows: RoadRow[] = [];
  const ouRows: RoadRow[] = [];
  for (const m of teamFinished(teamId, beforeUtc)) {
    if (ahRows.length >= n && ouRows.length >= n) break;
    const isHome = m.home_id === teamId;
    const gh = m.goals_home!;
    const ga = m.goals_away!;
    const base = {
      d: new Date(m.kickoff_utc + 8 * 3_600_000).toISOString().slice(5, 10),
      opp: nameZh(isHome ? m.away_name : m.home_name),
      ha: (isHome ? "主" : "客") as "主" | "客",
      score: `${gh}-${ga}`,
    };
    if (ahRows.length < n) {
      const snap = closing(m.fixture_id, "ah");
      if (snap?.line != null) {
        const homeDiff = gh - ga - snap.line; // line 正 = 主让
        ahRows.push({ ...base, line: ahText(isHome ? snap.line : -snap.line), res: ahResult(isHome ? homeDiff : -homeDiff) });
      }
    }
    if (ouRows.length < n) {
      const snap = closing(m.fixture_id, "ou");
      if (snap?.line != null) {
        ouRows.push({ ...base, line: ouText(snap.line), res: ouResult(gh + ga - snap.line) });
      }
    }
  }
  return {
    ah: { rows: ahRows, agg: aggRoad(ahRows, ["赢", "赢半"], ["输", "输半"]) },
    ou: { rows: ouRows, agg: aggRoad(ouRows, ["大", "大半"], ["小", "小半"]) },
  };
}

/* ── ② 凯利指数 + 离散度(纯函数,detail 即时盘调用)── */

export interface EuKelly {
  books: number;
  /** 各结果报价标准差(市场分歧度;越大各家分歧越大) */
  disp: { h: number; d: number; a: number };
  /** 全市场去水概率均值(凯利的基准概率) */
  prob: { h: number; d: number; a: number };
  method: string;
}

export function euKelly(lasts: { h: number; d: number | null; a: number }[]): EuKelly | null {
  const ok = lasts.filter((l) => l.h > 1 && (l.d ?? 0) > 1 && l.a > 1);
  if (ok.length < 3) return null; // 样本太少,共识无意义
  const dem = ok.map((l) => {
    const ih = 1 / l.h;
    const id = 1 / l.d!;
    const ia = 1 / l.a;
    const s = ih + id + ia;
    return { h: ih / s, d: id / s, a: ia / s };
  });
  const avg = (k: "h" | "d" | "a") => dem.reduce((s, x) => s + x[k], 0) / dem.length;
  const sd = (k: "h" | "d" | "a") => {
    const vals = ok.map((l) => (k === "d" ? l.d! : l[k]));
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.round(Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length) * 1000) / 1000;
  };
  return {
    books: ok.length,
    disp: { h: sd("h"), d: sd("d"), a: sd("a") },
    prob: { h: avg("h"), d: avg("d"), a: avg("a") },
    method: `凯利指数 = 该公司报价 × 全市场去水概率均值(${ok.length} 家);明显 >1 表示该公司此结果定价高于市场共识。离散度 = 各家公司报价标准差,越大代表市场分歧越大。`,
  };
}

/** 单家凯利(保留 2 位);prob 来自 euKelly */
export function kellyOf(odd: number | null, prob: number): number | null {
  return odd != null && odd > 1 ? Math.round(odd * prob * 100) / 100 : null;
}

/* ── ④ 升降盘统计 + 返还率(纯函数)── */

export function lineTrend(list: { first: { line: number | null }; last: { line: number | null } }[]) {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const c of list) {
    if (c.first.line == null || c.last.line == null) continue;
    if (c.last.line > c.first.line + EPS) up++;
    else if (c.last.line < c.first.line - EPS) down++;
    else flat++;
  }
  return up + down + flat > 0 ? { up, down, flat } : null;
}

/** 返还率(去掉抽水后的理论返还):双向 1/(1/h+1/a),三向再加平局 */
export function payoutRate(s: { h: number; a: number; d?: number | null } | null): number | null {
  if (!s || s.h <= 1 || s.a <= 1) return null;
  const inv = 1 / s.h + 1 / s.a + (s.d && s.d > 1 ? 1 / s.d : 0);
  return Math.round((1 / inv) * 1000) / 10;
}

/* ── ③ 同赔历史 ── */

function firstEuOf(fixtureId: number): { h: number; d: number; a: number } | null {
  const first = oddsSeries(fixtureId, "eu")[0];
  return first && first.d ? { h: first.h, d: first.d, a: first.a } : null;
}

function sameOddsOf(fx: FixtureRow) {
  const d = db();
  const first = firstEuOf(fx.fixture_id);
  if (!first) return null;
  // 各场首帧胜平负(本站归档起点≈初盘):与详情页主盘同源,避免同时间多书商导致行序漂移。
  const fixtures = d
    .prepare(
      `SELECT DISTINCT f.fixture_id fid, f.home_name, f.away_name, f.goals_home gh, f.goals_away ga, f.status, f.kickoff_utc
       FROM odds_snapshots s JOIN fixtures_cache f ON f.fixture_id = s.fixture_id
       WHERE s.market = 'eu'`,
    )
    .all() as unknown as { fid: number; home_name: string; away_name: string; gh: number | null; ga: number | null; status: string; kickoff_utc: number }[];
  const TOL = 0.03;
  const hits = fixtures.flatMap((r) => {
    if (r.fid === fx.fixture_id) return [];
    const snap = firstEuOf(r.fid);
    if (!snap) return [];
    return (
      isFinished(r.status) && r.gh != null && r.ga != null &&
      Math.abs(snap.h - first.h) <= TOL && Math.abs(snap.d - first.d) <= TOL && Math.abs(snap.a - first.a) <= TOL
    ) ? [r] : [];
  });
  if (hits.length === 0) return { triple: `${f2(first.h)}/${f2(first.d)}/${f2(first.a)}`, n: 0, w: 0, dr: 0, l: 0, samples: [] };
  const w = hits.filter((r) => r.gh! > r.ga!).length;
  const dr = hits.filter((r) => r.gh === r.ga).length;
  return {
    triple: `${f2(first.h)}/${f2(first.d)}/${f2(first.a)}`,
    n: hits.length,
    w, dr,
    l: hits.length - w - dr,
    samples: hits
      .sort((x, y) => y.kickoff_utc - x.kickoff_utc)
      .slice(0, 5)
      .map((r) => ({
        m: `${nameZh(r.home_name)} vs ${nameZh(r.away_name)}`,
        score: `${r.gh}-${r.ga}`,
        res: r.gh! > r.ga! ? "胜" : r.gh === r.ga ? "平" : "负",
      })),
  };
}

/* ── ⑤ 疲劳/赛程密度 ── */

function fatigueOf(teamId: number | null, kickoff: number, selfId: number) {
  if (!teamId) return null;
  const prev = teamFinished(teamId, kickoff, 6)[0];
  const next = (
    db()
      .prepare(
        "SELECT COUNT(*) c FROM fixtures_cache WHERE (home_id = ? OR away_id = ?) AND kickoff_utc > ? AND kickoff_utc <= ? AND fixture_id != ?",
      )
      .get(teamId, teamId, kickoff, kickoff + 7 * DAY, selfId) as { c: number }
  ).c;
  return {
    restDays: prev ? Math.max(0, Math.floor((kickoff - prev.kickoff_utc) / DAY)) : null,
    lastOpp: prev ? nameZh(prev.home_id === teamId ? prev.away_name : prev.home_name) : null,
    next7: next,
  };
}

/* ── ⑥ 角球参考 ── */

function cornersAvgOf(teamId: number | null, beforeUtc: number) {
  if (!teamId) return null;
  const totals: number[] = [];
  for (const m of teamFinished(teamId, beforeUtc, 12)) {
    if (totals.length >= 6) break;
    try {
      const blocks = (JSON.parse(m.payload) as { statistics?: unknown[] }).statistics ?? [];
      if (!Array.isArray(blocks) || blocks.length < 2) continue;
      let sum = 0;
      let got = false;
      for (const b of blocks) {
        const row = (Array.isArray(dig(b, "statistics")) ? (dig(b, "statistics") as unknown[]) : []).find(
          (s) => dig(s, "type") === "Corner Kicks",
        );
        const v = Number(dig(row, "value"));
        if (Number.isFinite(v)) {
          sum += v;
          got = true;
        }
      }
      if (got) totals.push(sum);
    } catch {
      /* 跳过坏包 */
    }
  }
  if (totals.length < 3) return null; // 样本太少不出参考值
  return { avg: Math.round((totals.reduce((s, v) => s + v, 0) / totals.length) * 10) / 10, n: totals.length };
}

/* ── 汇总(kv 缓存 10min:盘路/同赔涉及多场扫描,详情页 3s 轮询不能每次重算)── */

export async function insightsView(fx: FixtureRow) {
  return kvCached(`insights:${fx.fixture_id}`, 10 * 60_000, async () => {
    const home = teamRoad(fx.home_id, fx.kickoff_utc);
    const away = teamRoad(fx.away_id, fx.kickoff_utc);
    const ch = cornersAvgOf(fx.home_id, fx.kickoff_utc);
    const ca = cornersAvgOf(fx.away_id, fx.kickoff_utc);
    return {
      road: { home, away },
      sameOdds: sameOddsOf(fx),
      fatigue: { home: fatigueOf(fx.home_id, fx.kickoff_utc, fx.fixture_id), away: fatigueOf(fx.away_id, fx.kickoff_utc, fx.fixture_id) },
      cornersRef: ch && ca ? { h: ch, a: ca, ref: Math.round(((ch.avg + ca.avg) / 2) * 10) / 10 } : null,
      note: "盘路与同赔基于本站归档的临场盘与官方比分推算,自归档之日起积累;赛程仅统计本站收录赛事。",
    };
  });
}
