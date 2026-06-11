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
import { loadEnvFile } from "../src/server/env-file";
loadEnvFile();
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
import { cfgEmergencyThrottle, cfgFollowedIds, cfgTierIntervals } from "../src/server/platform/config";
import { dailyReadonlyCheck } from "../src/server/selfcheck";
import { fetchLlmBalance } from "../src/server/llm/client";
import { db } from "../src/server/db";

/** 联赛范围:后台「联赛开关」动态配置(env 兜底) */
function FOLLOWED(): number[] {
  const ids = cfgFollowedIds();
  if (ids.length > 0) return ids;
  return (process.env.FOLLOWED_LEAGUES || "39,140,78,135,61,2,3,1").split(",").map((x) => Number(x.trim())).filter(Boolean);
}

/** 有效抓取间隔:后台可调分层 + 紧急降频(手动开关或配额>85% 自动,×2) */
function effIntervalMs(tierIdx: number): number {
  const base = cfgTierIntervals()[tierIdx];
  let throttle = cfgEmergencyThrottle();
  try {
    const st = JSON.parse(kvGet("af_status") || "{}") as { current?: number; limit?: number };
    if (st.limit && st.current && st.current / st.limit > 0.85) throttle = true;
  } catch { /* ignore */ }
  return throttle ? base * 2 : base;
}

/** 端点健康上报(后台「数据与模型监控」) */
function recordEp(k: string, tier: string, ms: number, ok: boolean): void {
  const status = !ok ? "异常" : ms > 600 ? "慢" : "正常";
  db().prepare(
    "INSERT INTO endpoint_metrics (k, tier, last_at, ms, status) VALUES (?,?,?,?,?) ON CONFLICT(k) DO UPDATE SET tier=excluded.tier, last_at=excluded.last_at, ms=excluded.ms, status=excluded.status",
  ).run(k, tier, Date.now(), Math.round(ms), status);
}
async function tracked<T>(k: string, tier: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    recordEp(k, tier, Date.now() - t0, true);
    return r;
  } catch (e) {
    recordEp(k, tier, Date.now() - t0, false);
    throw e;
  }
}
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
  const env = await paced(() => tracked("fixtures?date", "日表 6h", () => afGetAllPages(`/fixtures?date=${date}`, 3, { force: true })));
  const items = Array.isArray(env.response) ? env.response : [];
  let n = 0;
  for (const item of items) {
    const lg = Number((item as { league?: { id?: number } }).league?.id);
    if (FOLLOWED().includes(lg) && upsertFixture(item)) n++;
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
    const env = await paced(() => tracked("fixtures (live)", "滚球 1min", () => afGet(`/fixtures?live=${FOLLOWED().join("-")}`, { force: true })));
    const items = Array.isArray(env.response) ? env.response : [];
    for (const item of items) upsertFixture(item);
  } catch (e) {
    log(`live 拉取失败:${msg(e)}`);
  }
  // 滚球 bundle 批量拉取(fixtures?ids= 一次最多 20 场,省配额;events/statistics/players 同请求带回)
  const lives = fixturesBetween(now - 4 * H, now).filter((x) => isLive(x.status));
  for (let i = 0; i < lives.length; i += 20) {
    const chunk = lives.slice(i, i + 20);
    const wanted = new Set(chunk.map((f) => f.fixture_id));
    try {
      const env = await paced(() => tracked("fixtures?ids (bundle)", "滚球快循环", () => afGet(`/fixtures?ids=${chunk.map((f) => f.fixture_id).join("-")}`, { force: true })));
      for (const item of Array.isArray(env.response) ? env.response : []) {
        const id = Number((item as { fixture?: { id?: number } }).fixture?.id);
        if (wanted.has(id)) upsertFixture(item); // 身份校验:只收请求过的场次
      }
    } catch (e) {
      log(`bundle 批量失败:${msg(e)}`);
    }
  }
  // 滚球实时盘(逐场,odds/live 按 fixture 过滤)
  for (const f of lives) {
    try {
      const env = await paced(() => tracked("odds.live", "滚球快循环", () => afGet(`/odds/live?fixture=${f.fixture_id}`, { force: true })));
      const raw = Array.isArray(env.response) ? env.response[0] : null;
      const item = raw && Number((raw as { fixture?: { id?: number } }).fixture?.id) === f.fixture_id ? raw : null;
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
  if (now - last >= effIntervalMs(tier.idx)) {
    lastOdds.set(fxId, now);
    try {
      // 拉满全部分页:AF /odds 按页返回,书商一个不漏;并做身份校验防串场
      const env = await paced(() => tracked("odds (bet 1/4/5)", tier.freq, () => afGetAllPages(`/odds?fixture=${fxId}`, 10, { force: true })));
      const items = (Array.isArray(env.response) ? env.response : []).filter(
        (it) => Number((it as { fixture?: { id?: number } }).fixture?.id) === fxId,
      );
      const item =
        items.length > 0
          ? { ...(items[0] as Record<string, unknown>), bookmakers: items.flatMap((it) => ((it as { bookmakers?: unknown[] }).bookmakers ?? [])) }
          : null;
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
      const env = await paced(() => tracked("predictions", "开盘+T-1h", () => afGet(`/predictions?fixture=${fxId}`, { force: true })));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      if (item) archivePrediction(fxId, item);
    } catch (e) {
      log(`predictions ${fxId} 失败:${msg(e)}`);
    }
  }
  // 首发:T-60 起每 5min 拉 bundle,拿到即停
  if (minsTo <= 60 && minsTo > 0 && !lineupDone.has(fxId) && Math.floor(now / 300_000) !== Math.floor(last / 300_000)) {
    try {
      const env = await paced(() => tracked("fixtures.lineups", "T-60m 5min", () => afGet(`/fixtures?id=${fxId}`, { force: true })));
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
  // 每小时:AF 配额(/status)与 LLM 余额(<\$100 由看板告警)
  const hourKey = `hourly:${new Date(now).toISOString().slice(0, 13)}`;
  if (!kvGet(hourKey)) {
    kvSet(hourKey, "1");
    try {
      const env = await paced(() => tracked("status", "每小时", () => afGet("/status", { force: true })));
      const r = (env.response ?? {}) as { subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } };
      kvSet("af_status", JSON.stringify({ plan: r.subscription?.plan, current: r.requests?.current, limit: r.requests?.limit_day, at: Date.now() }));
    } catch (e) {
      log(`/status 失败:${msg(e)}`);
    }
    await fetchLlmBalance().catch(() => null);
  }
  await dailyReadonlyCheck().catch((e) => log(`每日体检异常:${msg(e)}`));
  kvSet("worker_heartbeat", String(Date.now()));
}

/** 滚球快循环:仅滚球场次的 比分bundle + 滚球盘 + 赛前盘,间隔由后台「滚球档」控制(可至 5s) */
async function liveFast(now: number): Promise<void> {
  const lives = fixturesBetween(now - 4 * H, now).filter((x) => isLive(x.status));
  if (lives.length === 0) return;
  await tickLive(now);
  for (const f of lives) await tickFixture(f.fixture_id, now);
}

async function main(): Promise<void> {
  log(`worker 启动:联赛 ${FOLLOWED().join(",")} · 调用间隔 ${DELAY}ms · 双速循环(整轮 ${TICK_MS / 1000}s + 滚球快循环按后台配置,最低 5s)`);
  let lastFull = 0;
  let lastLive = 0;
  for (;;) {
    const now = Date.now();
    try {
      if (now - lastFull >= TICK_MS) {
        lastFull = now;
        await cycle();
        lastLive = Date.now();
      } else {
        const liveIv = Math.max(5_000, cfgTierIntervals()[6] ?? 60_000);
        if (now - lastLive >= liveIv) {
          lastLive = now;
          await liveFast(now);
        }
      }
    } catch (e) {
      log(`循环异常:${msg(e)}`);
    }
    kvSet("worker_heartbeat", String(Date.now()));
    await sleep(2_500);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
