/**
 * PlayTop 综合指数:多书商指数聚合成单一可信计价(走势图主线),方法论随 payload 下发给用户。
 * 赛前:时间分桶(≥5min,自适应窗口),桶内各书商最后值前推(6h 失效);
 *   共识指数线 = 各家主指数线中位数;指数值 = 报共识指数线书商的主侧净水中位数(不足 3 家回退全体中位数);
 *   eu = 去水主胜概率中位数。
 * 滚球:实时帧直读(单源,变化帧)。指数为计算值,不是任何一家的原始报价。
 */
import { db } from "../db";
import type { SnapRow } from "../af/store";
import { liveOddsSeries } from "../af/live-store";

export interface IndexPoint {
  t: number;
  v: number;
  line: number | null;
  n: number; // 参与书商家数(滚球段为 1=实时盘)
  phase: "pre" | "live";
}
export interface CompositeIndex {
  points: IndexPoint[];
  markers: { t: number; from: number | null; to: number | null }[]; // 共识指数线变化点
  method: string;
  books: number;
}

const PRE_BUCKET_MIN = 5 * 60_000;
const STALE_MS = 6 * 3_600_000;
const MAX_POINTS = 300;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 1000) / 1000;
}
/** 指数线中位数必须是真实存在的指数线值(取下中位元素,不平均出 0.375 这类假盘) */
function medianLine(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}
const euProb = (h: number, d: number, a: number) => {
  const ih = 1 / h, id = 1 / d, ia = 1 / a;
  return Math.round((ih / (ih + id + ia)) * 1000) / 1000;
};

function allSnapshots(fixtureId: number, market: string): SnapRow[] {
  return db()
    .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? ORDER BY captured_at")
    .all(fixtureId, market) as unknown as SnapRow[];
}

/** 赛前段(计算较重,调用方可缓存 60s;指数慢变,延迟无感) */
export function compositePre(fixtureId: number, market: "ah" | "ou" | "eu", kickoffUtcMs: number): { points: IndexPoint[]; books: number } {
  const rows = allSnapshots(fixtureId, market);
  const points: IndexPoint[] = [];
  const bookSet = new Set(rows.map((r) => r.bookmaker));

  if (rows.length > 0) {
    const t0 = rows[0].captured_at;
    const tEnd = Math.min(rows[rows.length - 1].captured_at, kickoffUtcMs || Infinity);
    const span = Math.max(0, tEnd - t0);
    const bucketMs = Math.max(PRE_BUCKET_MIN, Math.ceil(span / MAX_POINTS / PRE_BUCKET_MIN) * PRE_BUCKET_MIN);
    // 单次扫描:按桶推进,维护每书商最后帧
    const lastByBook = new Map<string, SnapRow>();
    let i = 0;
    for (let bEnd = t0 + bucketMs; bEnd <= tEnd + bucketMs; bEnd += bucketMs) {
      while (i < rows.length && rows[i].captured_at < bEnd) {
        lastByBook.set(rows[i].bookmaker, rows[i]);
        i++;
      }
      const active = [...lastByBook.values()].filter((r) => bEnd - r.captured_at <= STALE_MS);
      if (active.length === 0) continue;
      const t = Math.min(bEnd, tEnd);
      if (market === "eu") {
        const ps = active.filter((r) => r.h > 1 && (r.d ?? 0) > 1 && r.a > 1).map((r) => euProb(r.h, r.d ?? 0, r.a));
        if (ps.length > 0) points.push({ t, v: median(ps), line: null, n: ps.length, phase: "pre" });
      } else {
        const lined = active.filter((r) => r.line != null);
        if (lined.length === 0) continue;
        const consensus = medianLine(lined.map((r) => r.line as number));
        const atLine = lined.filter((r) => r.line === consensus).map((r) => r.h);
        const vals = atLine.length >= Math.min(3, lined.length) ? atLine : lined.map((r) => r.h);
        points.push({ t, v: median(vals), line: consensus, n: lined.length, phase: "pre" });
      }
      if (i >= rows.length && t >= tEnd) break;
    }
  }
  return { points, books: bookSet.size };
}

/** 滚球段:实时帧直读(已是变化帧,无需分桶;封盘帧不进指数)——必须实时计算,不可缓存 */
export function compositeLive(fixtureId: number, market: "ah" | "ou" | "eu"): IndexPoint[] {
  const points: IndexPoint[] = [];
  const lv = liveOddsSeries(fixtureId, market).filter((r) => !r.suspended);
  for (const r of lv.slice(-MAX_POINTS)) {
    if (market === "eu") {
      if (r.h > 1 && (r.d ?? 0) > 1 && r.a > 1) points.push({ t: r.captured_at, v: euProb(r.h, r.d ?? 0, r.a), line: null, n: 1, phase: "live" });
    } else if (r.line != null) {
      points.push({ t: r.captured_at, v: r.h, line: r.line, n: 1, phase: "live" });
    }
  }
  return points;
}

export function mergeComposite(pre: { points: IndexPoint[]; books: number }, liveSeg: IndexPoint[], market: "ah" | "ou" | "eu"): CompositeIndex {
  const points = [...pre.points, ...liveSeg];
  const markers: CompositeIndex["markers"] = [];
  for (let k = 1; k < points.length; k++) {
    if (points[k].line !== points[k - 1].line) markers.push({ t: points[k].t, from: points[k - 1].line, to: points[k].line });
  }
  const method =
    market === "eu"
      ? `综合指数 = ${pre.books} 家书商去水主胜概率中位数;滚球段为实时盘直读。指数为本站计算值,非任何单一公司报价。`
      : `综合指数 = ${pre.books} 家书商共识主指数线(指数线中位数)下的主侧净水中位数;滚球段为实时盘直读。指数为本站计算值,非任何单一公司报价。`;
  return { points, markers, method, books: pre.books };
}
