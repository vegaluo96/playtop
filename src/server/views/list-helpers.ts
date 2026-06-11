/** 列表页 DB 取数小件(从 store 转出,带轻量缓存语义) */
import { db } from "../db";
import { dailyFreeFixtureIds } from "../platform/wallet";

export { fixturesBetween, oddsSeries } from "../af/store";

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

/** 近 12h 内有异动记录 → 列表「异动」标 */
export function movedRecently(fixtureId: number): boolean {
  return !!db()
    .prepare("SELECT 1 FROM movements WHERE fixture_id = ? AND t1 >= ? LIMIT 1")
    .get(fixtureId, Date.now() - 12 * 3_600_000);
}
