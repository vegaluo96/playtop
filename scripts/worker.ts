/**
 * 数据抓取 worker(独立进程:npm run worker)。
 * 按「距开赛时间」分层轮询(src/server/af/schedule.ts),所有端点共享本调度器:
 *   /fixtures(日表 6h;滚球窗口 live=联赛ids 每 1min;单场 bundle 滚球期每 1min)
 *   /odds?fixture= 随分层,每次快照落库,相邻快照 diff 生成异动
 *   /odds/live      仅滚球期每 1min(落 kv)
 *   /predictions    开盘抓 1 次;开赛前 1h 复抓 1 次
 *   /fixtures?id=   T-60min 起每 5min(拿到首发即停;滚球期本身就是 1min)
 *   完场 → 模型战绩结算;每日选定 1 场免费预测
 * 配额保护:相邻出网调用间隔 AF_DELAY_MS(默认 300ms),叠加 client 层 2s 同 URL 防抖。
 */
import { afGet, afGetAllPages } from "../src/server/af/client";
import { isFinished, isLive, tierFor } from "../src/server/af/schedule";
import {
  archiveOdds,
  archivePrediction,
  fixtureById,
  fixturesBetween,
  hasPrediction,
  kvGet,
  kvSet,
  setDailyFree,
  settleFixture,
  upsertFixture,
} from "../src/server/af/store";

const FOLLOWED = (process.env.FOLLOWED_LEAGUES || "39,140,78,135,61,2,3,1")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);
const DELAY = Number(process.env.AF_DELAY_MS || 300);
const TICK_MS = 60_000;
const H = 3_600_000;
const TZ8 = 8 * H;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastCallAt = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCallAt + DELAY - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  return fn();
}

const day8 = (nowMs: number, offset = 0) => new Date(nowMs + TZ8 + offset * 86_400_000).toISOString().slice(0, 10);

const lastOdds = new Map<number, number>();
const lineupDone = new Set<number>();
const predRefetched = new Set<number>();

async function refreshDayFixtures(date: string): Promise<void> {
  const key = `fixtures_day:${date}`;
  const last = Number(kvGet(key) ?? 0);
  if (Date.now() - last < 6 * H) return;
  const env = await paced(() => afGetAllPages(`/fixtures?date=${date}`, 3, { force: true }));
  const items = Array.isArray(env.response) ? env.response : [];
  let n = 0;
  for (const item of items) {
    const lg = Number((item as { league?: { id?: number } }).league?.id);
    if (FOLLOWED.includes(lg) && upsertFixture(item)) n++;
  }
  kvSet(key, String(Date.now()));
  log(`日表 ${date}:${n}/${items.length} 场(关注联赛)`);
}

async function tickLive(now: number): Promise<void> {
  const window = fixturesBetween(now - 4 * H, now + 5 * 60_000).filter(
    (f) => !isFinished(f.status) && f.kickoff_utc <= now + 5 * 60_000,
  );
  if (window.length === 0) return;
  try {
    const env = await paced(() => afGet(`/fixtures?live=${FOLLOWED.join("-")}`, { force: true }));
    const items = Array.isArray(env.response) ? env.response : [];
    for (const item of items) upsertFixture(item);
  } catch (e) {
    log(`live 拉取失败:${msg(e)}`);
  }
  // 滚球单场 bundle(events/statistics/players 同一请求带回)
  for (const f of fixturesBetween(now - 4 * H, now).filter((x) => isLive(x.status))) {
    try {
      const env = await paced(() => afGet(`/fixtures?id=${f.fixture_id}`, { force: true }));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      if (item) upsertFixture(item);
    } catch (e) {
      log(`bundle ${f.fixture_id} 失败:${msg(e)}`);
    }
    // 滚球实时盘
    try {
      const env = await paced(() => afGet(`/odds/live?fixture=${f.fixture_id}`, { force: true }));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      kvSet(`fx:${f.fixture_id}:liveodds`, JSON.stringify({ at: Date.now(), data: item ?? null }));
    } catch {
      /* 滚球赔率非必得 */
    }
  }
}

async function tickFixture(fxId: number, now: number): Promise<void> {
  const f = fixtureById(fxId);
  if (!f || isFinished(f.status)) return;
  const tier = tierFor(f.kickoff_utc, now, f.status);
  const last = lastOdds.get(fxId) ?? 0;
  if (now - last >= tier.intervalMs) {
    lastOdds.set(fxId, now);
    try {
      const env = await paced(() => afGet(`/odds?fixture=${fxId}`, { force: true }));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      if (item) {
        const moves = archiveOdds(fxId, item);
        if (moves > 0) log(`异动 +${moves}:${f.home_name} vs ${f.away_name}`);
      }
    } catch (e) {
      log(`odds ${fxId} 失败:${msg(e)}`);
    }
  }
  // 预测:开盘抓 1 次;T-60min 复抓 1 次
  const minsTo = (f.kickoff_utc - now) / 60_000;
  if (!hasPrediction(fxId) || (minsTo <= 60 && minsTo > 0 && !predRefetched.has(fxId))) {
    if (minsTo <= 60) predRefetched.add(fxId);
    try {
      const env = await paced(() => afGet(`/predictions?fixture=${fxId}`, { force: true }));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      if (item) archivePrediction(fxId, item);
    } catch (e) {
      log(`predictions ${fxId} 失败:${msg(e)}`);
    }
  }
  // 首发:T-60 起每 5min 拉 bundle,拿到即停
  if (minsTo <= 60 && minsTo > 0 && !lineupDone.has(fxId) && Math.floor(now / 300_000) !== Math.floor(last / 300_000)) {
    try {
      const env = await paced(() => afGet(`/fixtures?id=${fxId}`, { force: true }));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      if (item) {
        upsertFixture(item);
        const lineups = (item as { lineups?: unknown[] }).lineups;
        if (Array.isArray(lineups) && lineups.length >= 2) {
          lineupDone.add(fxId);
          log(`首发已到:${f.home_name} vs ${f.away_name}`);
        }
      }
    } catch {
      /* 下轮再试 */
    }
  }
}

function settleAndDailyFree(now: number): void {
  const today = day8(now);
  for (const f of fixturesBetween(now - 36 * H, now)) {
    if (isFinished(f.status)) settleFixture(f);
  }
  const todays = fixturesBetween(now - TZ8, now - TZ8 + 86_400_000).filter((f) => day8(f.kickoff_utc) === today);
  if (todays.length > 0) setDailyFree(today, todays.sort((a, b) => a.kickoff_utc - b.kickoff_utc)[0].fixture_id);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function log(s: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

async function cycle(): Promise<void> {
  const now = Date.now();
  await refreshDayFixtures(day8(now));
  await refreshDayFixtures(day8(now, 1));
  const ydayKey = `fixtures_yday:${day8(now)}`;
  if (!kvGet(ydayKey)) {
    kvSet(ydayKey, "1");
    await refreshDayFixtures(day8(now, -1)).catch(() => {});
  }
  await tickLive(now);
  const horizon = fixturesBetween(now - 4 * H, now + 36 * H);
  for (const f of horizon) await tickFixture(f.fixture_id, now);
  settleAndDailyFree(now);
  kvSet("worker_heartbeat", String(Date.now()));
}

async function main(): Promise<void> {
  log(`worker 启动:联赛 ${FOLLOWED.join(",")} · 调用间隔 ${DELAY}ms`);
  for (;;) {
    const t0 = Date.now();
    try {
      await cycle();
    } catch (e) {
      log(`cycle 异常:${msg(e)}`);
    }
    const elapsed = Date.now() - t0;
    if (elapsed < TICK_MS) await sleep(TICK_MS - elapsed);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
