/** 列表页 DB 取数小件(从 store 转出,带轻量缓存语义) */
import { db } from "../db";
import { dailyFreeFixtureIds } from "../platform/wallet";
import { oddsSeries, type SnapRow } from "../af/store";
import { liveOddsSeries } from "../af/live-store";

export { fixturesBetween, oddsSeries } from "../af/store";

/** 列表行情序列:滚球场拼上实时帧尾巴(最近 2 帧,保留涨跌方向),数值随 5s 抓取真实跳动 */
export function liveAwareSeries(fixtureId: number, market: "ah" | "ou" | "eu", live: boolean): SnapRow[] {
  const pre = oddsSeries(fixtureId, market);
  if (!live) return pre;
  const lv = liveOddsSeries(fixtureId, market).filter((r) => !r.suspended);
  if (lv.length === 0) return pre;
  const mapped: SnapRow[] = lv.slice(-2).map((r) => ({
    fixture_id: fixtureId, bookmaker_id: 0, bookmaker: "实时盘", market,
    line: r.line, h: r.h, a: r.a, d: r.d, captured_at: r.captured_at,
  }));
  return [...pre, ...mapped];
}

/** 今日免费场集合(可多场) */
export function dailyFreeSetToday(): Set<number> {
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  return new Set(dailyFreeFixtureIds(today));
}

/** 后台隐藏的场次(列表不展示,数据仍归档) */
export function hiddenFixtureIds(): Set<number> {
  const rows = db().prepare("SELECT fixture_id FROM hidden_fixtures").all() as unknown as { fixture_id: number }[];
  return new Set(rows.map((r) => r.fixture_id));
}

/** 滚球行内增强:半场比分/角球数/红牌(payload 已带,零新增请求);拿不到的项为 null */
export function liveExtras(payload: string): { ht: string | null; cor: string | null; red: string | null } {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    const dig = (o: unknown, ...path: string[]): unknown => {
      let c: unknown = o;
      for (const k of path) {
        if (c && typeof c === "object") c = (c as Record<string, unknown>)[k];
        else return undefined;
      }
      return c;
    };
    const hth = dig(p, "score", "halftime", "home");
    const ht = hth != null ? `${hth}-${dig(p, "score", "halftime", "away")}` : null;
    const blocks = Array.isArray(p.statistics) ? (p.statistics as unknown[]) : [];
    const stat = (b: unknown, type: string) => {
      const rows = dig(b, "statistics");
      const row = Array.isArray(rows) ? rows.find((s) => dig(s, "type") === type) : null;
      const v = Number(dig(row, "value"));
      return Number.isFinite(v) ? v : null;
    };
    let cor: string | null = null;
    let red: string | null = null;
    if (blocks.length >= 2) {
      const [c0, c1] = [stat(blocks[0], "Corner Kicks"), stat(blocks[1], "Corner Kicks")];
      if (c0 != null && c1 != null) cor = `${c0}-${c1}`;
      const [r0, r1] = [stat(blocks[0], "Red Cards") ?? 0, stat(blocks[1], "Red Cards") ?? 0];
      if ((r0 as number) + (r1 as number) > 0) red = `${r0}-${r1}`;
    }
    return { ht, cor, red };
  } catch {
    return { ht: null, cor: null, red: null };
  }
}

/** 近 12h 内有异动记录 → 列表「异动」标 */
export function movedRecently(fixtureId: number): boolean {
  return !!db()
    .prepare("SELECT 1 FROM movements WHERE fixture_id = ? AND t1 >= ? LIMIT 1")
    .get(fixtureId, Date.now() - 12 * 3_600_000);
}
