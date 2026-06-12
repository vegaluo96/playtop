/**
 * 历史报价:某场某市场自归档起的全部快照帧(盘前书商序列 + 滚球实时帧),
 * 走势页只展示变盘点摘要,这里给用户完整逐帧回查。最新在上,封顶 500 帧。
 */
import { ahText, dateStr, f2, hhmm, maskBookmaker, ouText } from "@/lib/format";
import { isFinished, isLive } from "../af/schedule";
import { liveOddsSeries } from "../af/live-store";
import { isDisplayableLiveSnapshot, isDisplayableSnapshot } from "../af/odds-quality";
import { db } from "../db";
import { fixtureById, oddsSeries, type SnapRow } from "../af/store";

export interface QuoteRow {
  t: string; // "MM-DD HH:mm"
  text: string | null; // 指数文本(eu 为 null)
  h: string;
  a: string;
  d: string | null;
  chg: boolean; // 相对上一帧变盘(指数线变化)
  live: boolean; // 滚球帧
}

/**
 * @param bookmakerId 指定书商:对比行点入,只看该公司的赛前序列(滚球帧无书商维度,不并入)
 */
export function quoteHistory(fixtureId: number, market: "ah" | "ou" | "eu", tz: string, bookmakerId?: number) {
  const fx = fixtureById(fixtureId);
  if (!fx) return null;
  const pre = bookmakerId
    ? (db()
        .prepare("SELECT * FROM odds_snapshots WHERE fixture_id = ? AND market = ? AND bookmaker_id = ? ORDER BY captured_at")
        .all(fixtureId, market, bookmakerId) as unknown as SnapRow[]).filter((r) => isDisplayableSnapshot(market, r))
    : oddsSeries(fixtureId, market);
  const started = !bookmakerId && (isLive(fx.status) || isFinished(fx.status));
  const rawLive = started ? liveOddsSeries(fixtureId, market).filter((r) => !r.suspended) : [];
  const liveOk = rawLive.length === 0 || isDisplayableLiveSnapshot(market, rawLive[rawLive.length - 1]);
  const live: SnapRow[] = started
    ? (liveOk ? rawLive : [])
        .filter((r) => isDisplayableLiveSnapshot(market, r))
        .map((r) => ({
          fixture_id: fixtureId, bookmaker_id: 0, bookmaker: "实时盘", market,
          line: r.line, h: r.h, a: r.a, d: r.d, captured_at: r.captured_at,
        }))
    : [];
  const all = [...pre, ...live].sort((x, y) => x.captured_at - y.captured_at);
  const rows: QuoteRow[] = [];
  let prevLine: number | null | undefined;
  for (const s of all) {
    rows.push({
      t: `${dateStr(s.captured_at, tz).slice(5)} ${hhmm(s.captured_at, tz)}`,
      text: market === "ah" ? ahText(s.line ?? 0) : market === "ou" ? ouText(s.line ?? 0) : null,
      h: f2(s.h),
      a: f2(s.a),
      d: market === "eu" ? f2(s.d ?? 0) : null,
      chg: prevLine !== undefined && market !== "eu" && s.line !== prevLine,
      live: s.captured_at >= fx.kickoff_utc && live.length > 0 && s.bookmaker === "实时盘",
    });
    prevLine = s.line;
  }
  rows.reverse(); // 最新在上
  return {
    n: all.length,
    src: pre.length > 0 ? maskBookmaker(pre[0].bookmaker) : null,
    startAt: all.length > 0 ? dateStr(all[0].captured_at, tz) : null,
    rows: rows.slice(0, 500),
  };
}
