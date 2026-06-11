/** 列表页 DB 取数小件(从 store 转出,带轻量缓存语义) */
import { db } from "../db";
import { dailyFreeFixture } from "../platform/wallet";

export { fixturesBetween, oddsSeries } from "../af/store";

export function dailyFreeFixtureToday(): number | null {
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  return dailyFreeFixture(today);
}

/** 近 12h 内有异动记录 → 列表「异动」标 */
export function movedRecently(fixtureId: number): boolean {
  return !!db()
    .prepare("SELECT 1 FROM movements WHERE fixture_id = ? AND t1 >= ? LIMIT 1")
    .get(fixtureId, Date.now() - 12 * 3_600_000);
}
