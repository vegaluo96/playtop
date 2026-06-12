/**
 * 数据抓取 worker(独立进程:npm run worker)。
 * 按「距开赛时间」分层轮询(src/server/af/schedule.ts),所有端点共享本调度器:
 *   /fixtures(日表 6h;滚球窗口 live=联赛ids 每 1min;单场 bundle 滚球期每 1min)
 *   /odds?fixture= 随分层,每次快照落库,相邻快照 diff 生成异动
 *   /odds/live      仅滚球期每 1min(落 kv)
 *   /predictions    开盘抓 1 次;开赛前 1h 复抓 1 次
 *   /fixtures/lineups T-60min 起每 5min(拿到首发即停)
 *   /fixtures/events|statistics|lineups|players 滚球期独立端点补抓并合并到 fixture payload
 *   完场 → 模型战绩结算;每日选定 1 场免费分析
 * 配额保护:相邻出网调用间隔 AF_DELAY_MS(默认 300ms),叠加 client 层 2s 同 URL 防抖。
 */
import { loadEnvFile } from "../src/server/env-file";
loadEnvFile();
import { afGet, afGetAllPages } from "../src/server/af/client";
import { isFinished, isLive, LIVE_TIER, tierFor } from "../src/server/af/schedule";
import {
  archiveOdds,
  archivePrediction,
  fixtureById,
  fixturesBetween,
  hasPrediction,
  kvGet,
  kvSet,
  setDailyFree,
  freeFixtureCount,
  settleFixture,
  upsertFixture,
} from "../src/server/af/store";
import { cfgEmergencyThrottle, cfgFollowedIds, cfgTierIntervals } from "../src/server/platform/config";
import { dailyReadonlyCheck } from "../src/server/selfcheck";
import { fetchLlmBalance } from "../src/server/llm/client";
import { archiveLiveOdds, pruneLiveData } from "../src/server/af/live-store";
import { normalizeLiveOddsItem } from "../src/server/af/normalize";
import { synthFromFixture } from "../src/server/af/events-synth";
import { refreshFixtureDetailsFromAf } from "../src/server/af/fixture-details";
import { getLlmReport, shouldPregenReport } from "../src/server/llm/report";
import { buildReport } from "../src/server/views/report";
import { matchPanorama } from "../src/server/af/panorama";
import { drainNameQueue } from "../src/server/views/names";
import { db, tx } from "../src/server/db";
import { endpointHealthStatus } from "../src/server/admin/monitoring";

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
  const status = endpointHealthStatus(ms, ok);
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
const lastHalf = new Map<number, number>();
const lastDetail = new Map<number, number>();
const lastLineup = new Map<number, number>();
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
  // 出网拉取仅在有在售/滚球场次时进行(配额保护);后面的事件合成零出网,必须每轮跑——
  // 否则「窗口里只剩刚完场场次」时完场节点会漏记
  if (window.length > 0) {
    try {
      const env = await paced(() => tracked("fixtures (live)", "滚球 1min", () => afGet(`/fixtures?live=${FOLLOWED().join("-")}`, { force: true })));
      const items = Array.isArray(env.response) ? env.response : [];
      for (const item of items) upsertFixture(item);
    } catch (e) {
      log(`live 拉取失败:${msg(e)}`);
    }
  }
  // 滚球基础比分批量拉取(fixtures?ids= 一次最多 20 场,省配额);详情字段由独立端点补抓
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
  // 半场拆分统计(half=true,每场 60s 一拉,存 kv 供技术面「半场拆分」容器)
  for (const f of lives) {
    const last = lastHalf.get(f.fixture_id) ?? 0;
    if (now - last >= 60_000) {
      lastHalf.set(f.fixture_id, now);
      try {
        const env = await paced(() => tracked("fixtures.statistics (half)", "滚球 60s", () => afGet(`/fixtures/statistics?fixture=${f.fixture_id}&half=true`, { force: true })));
        if (Array.isArray(env.response) && env.response.length > 0) {
          kvSet(`fx:${f.fixture_id}:stats_half`, JSON.stringify({ at: Date.now(), data: env.response }));
        }
      } catch {
        /* 半场统计非必得 */
      }
    }
  }
  // 单场详情独立端点补抓:不依赖 /fixtures?id 是否携带 events/statistics/lineups/players。
  for (const f of lives) {
    const last = lastDetail.get(f.fixture_id) ?? 0;
    if (now - last >= 60_000) {
      lastDetail.set(f.fixture_id, now);
      await refreshFixtureDetails(f.fixture_id, "滚球详情 60s", {
        events: true,
        statistics: true,
        lineups: true,
        players: Math.floor(now / 300_000) !== Math.floor(last / 300_000),
      }).catch((e) => log(`fixture details ${f.fixture_id} 失败:${msg(e)}`));
    }
  }
  // 统计差分合成事件(角球/射正/射偏/越位 + 开赛/中场/完场节点 → 详情页「赛况」时间轴);
  // 窗口不滤完场:刚完场的场次还要落「完场」节点,幂等无变化零写入
  for (const f of fixturesBetween(now - 4 * H, now + 5 * 60_000)) {
    try {
      synthFromFixture(f);
    } catch (e) {
      log(`事件合成 ${f.fixture_id} 异常:${msg(e)}`);
    }
  }
  // 滚球实时盘(逐场,odds/live 按 fixture 过滤):kv 给实时盘卡,同步归档变化帧 → 走势图滚球段 + 滚球异动
  for (const f of lives) {
    try {
      const env = await paced(() => tracked("odds.live", "滚球快循环", () => afGet(`/odds/live?fixture=${f.fixture_id}`, { force: true })));
      const raw = Array.isArray(env.response) ? env.response[0] : null;
      const item = raw && Number((raw as { fixture?: { id?: number } }).fixture?.id) === f.fixture_id ? raw : null;
      kvSet(`fx:${f.fixture_id}:liveodds`, JSON.stringify({ at: Date.now(), data: item ?? null }));
      if (item) {
        const frames = normalizeLiveOddsItem(item);
        if (frames.length > 0) tx(() => archiveLiveOdds(f.fixture_id, frames, Date.now()));
      }
    } catch {
      /* 滚球赔率非必得 */
    }
  }
}

async function refreshFixtureDetails(
  fixtureId: number,
  tier: string,
  parts: { events?: boolean; statistics?: boolean; lineups?: boolean; players?: boolean },
): Promise<Record<string, unknown>> {
  return refreshFixtureDetailsFromAf(fixtureId, parts, {
    fetcher: (key, path) => paced(() => tracked(key, tier, () => afGet(path, { force: true }))),
  });
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
  // AI 报告预生成:跟随抓取频次检查,指纹变化才出新版(getLlmReport 内部判),开赛锁定
  if (shouldPregenReport(fxId, f.kickoff_utc, f.status, now)) {
    try {
      const p = await matchPanorama(fxId);
      if (p) {
        const { secs } = buildReport(p);
        const r = await getLlmReport(p, secs);
        if (r) log(`报告预生成:${f.home_name} vs ${f.away_name}(${r.by})`);
      }
    } catch (e) {
      log(`报告预生成 ${fxId} 失败:${msg(e)}`);
    }
  }

  // 预测:入窗(14 天)即抓;窗口内每日刷一版;T-60min 再复抓 1 次锁临场版
  const minsTo = (f.kickoff_utc - now) / 60_000;
  const predDayKey = `pred_day:${fxId}:${day8(now)}`;
  const needDaily = minsTo > 60 && !kvGet(predDayKey);
  if (!hasPrediction(fxId) || needDaily || (minsTo <= 60 && minsTo > 0 && !predRefetched.has(fxId))) {
    if (minsTo <= 60) predRefetched.add(fxId);
    try {
      const env = await paced(() => tracked("predictions", "入窗+每日+T-1h", () => afGet(`/predictions?fixture=${fxId}`, { force: true })));
      const item = Array.isArray(env.response) ? env.response[0] : null;
      if (item) {
        archivePrediction(fxId, item);
        kvSet(predDayKey, "1");
      }
    } catch (e) {
      log(`predictions ${fxId} 失败:${msg(e)}`);
    }
  }
  // 首发:T-60 起每 5min 拉 AF 独立 lineups 端点,拿到即停
  const lastLu = lastLineup.get(fxId) ?? 0;
  if (minsTo <= 60 && minsTo > 0 && !lineupDone.has(fxId) && now - lastLu >= 300_000) {
    lastLineup.set(fxId, now);
    try {
      const patch = await refreshFixtureDetails(fxId, "T-60m 5min", { lineups: true });
      const lineups = patch.lineups;
      if (Array.isArray(lineups) && lineups.length >= 2) {
        lineupDone.add(fxId);
        log(`首发已到:${f.home_name} vs ${f.away_name}`);
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
  // 仅当后台当日尚未指定任何免费场时自动选定一场,不覆盖运营的多场配置
  const todays = fixturesBetween(now - TZ8, now - TZ8 + 86_400_000).filter((f) => day8(f.kickoff_utc) === today);
  if (todays.length > 0 && freeFixtureCount(today) === 0)
    setDailyFree(today, todays.sort((a, b) => a.kickoff_utc - b.kickoff_utc)[0].fixture_id);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function log(s: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

async function cycle(): Promise<void> {
  const now = Date.now();
  // 初盘容器:AF 赛前赔率覆盖开赛前 1–14 天,赛程提前 14 天入库、赔率随分层从入窗起归档,
  // 「首帧」从此≈真实初盘
  for (let d = 0; d <= 13; d++) await refreshDayFixtures(day8(now, d));
  const ydayKey = `fixtures_yday:${day8(now)}`;
  if (!kvGet(ydayKey)) {
    kvSet(ydayKey, "1");
    await refreshDayFixtures(day8(now, -1)).catch(() => {});
  }
  await tickLive(now);
  const horizon = fixturesBetween(now - 4 * H, now + 14 * 24 * H);
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
  // 每 10 分钟清一次译名队列(队列空则零成本;球员名靠它补齐,不能等每小时)
  const nameKey = `namedrain:${Math.floor(now / 600_000)}`;
  if (!kvGet(nameKey)) {
    kvSet(nameKey, "1");
    const named = await drainNameQueue(40).catch(() => 0);
    if (named > 0) log(`译名入库 +${named}`);
  }
  // 每日数据保鲜:清完场 >7d 滚球帧 / >30d 原始包
  const pruneKey = `prune:${day8(now)}`;
  if (!kvGet(pruneKey)) {
    kvSet(pruneKey, "1");
    try {
      const r = pruneLiveData(now);
      if (r.liveRows + r.rawRows > 0) log(`保鲜清理:滚球帧 ${r.liveRows} 行 · odds_raw ${r.rawRows} 行`);
    } catch (e) {
      log(`保鲜清理异常:${msg(e)}`);
    }
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
        const liveIv = Math.max(5_000, cfgTierIntervals()[LIVE_TIER] ?? 60_000);
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
