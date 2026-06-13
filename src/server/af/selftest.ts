/**
 * AF 数据层真机自检（npm run af -- selftest）：
 * 对全部 39 个端点各打一枪真实请求，汇总「回数据 / 空 / 报错 / 跳过」与配额消耗。
 *
 * 设计要点：
 * - 自适应取参：先解析一个真实上下文（联赛→赛季→一场已结束比赛→主客队→球员→教练），
 *   再把真实 ID 喂给依赖型端点（单场统计/事件/阵容/预测/赔率…），最大化命中真数据。
 * - 依赖缺失则标 skipped 并注明原因，绝不静默漏测。
 * - 起止各读一次 /status，算出本次净消耗的请求数（可复现的配额证据）。
 * - 每次调用 try/catch，单点失败不影响整体；可选 delay 适配限流套餐。
 */
import { afGet, type AfEnvelope } from "./client";
import { dig } from "@/lib/dig";
import { AF_ENDPOINTS, runAfEndpoint, afEndpointByKey } from "./catalog";

export interface SelftestContext {
  league: string;
  season: string;
  team?: string;
  fixture?: string;
  home?: string;
  away?: string;
  player?: string;
  coach?: string;
}

export interface SelftestRow {
  key: string;
  label: string;
  path: string;
  status: "ok" | "empty" | "error" | "skipped";
  results: number;
  note?: string;
}

export interface SelftestAccount {
  plan?: string;
  active?: boolean;
  current?: number;
  limitDay?: number;
}

export interface SelftestReport {
  account: SelftestAccount | null;
  consumed: number | null;
  context: SelftestContext;
  rows: SelftestRow[];
  summary: { total: number; ok: number; empty: number; error: number; skipped: number };
}

/* 安全取值：在未知 JSON 上按路径钻取 */
function firstArr(env: AfEnvelope | { response: unknown }): Record<string, unknown> | undefined {
  const r = (env as { response?: unknown }).response;
  return Array.isArray(r) && r.length > 0 ? (r[0] as Record<string, unknown>) : undefined;
}

/**
 * 依赖完整上下文时，每个端点该用的参数；返回 null 表示「依赖缺失，跳过」。
 * 纯函数：无网络，便于单测保证 39 端点一个不漏。
 */
export function paramsFor(key: string, ctx: SelftestContext): Record<string, string> | null {
  const { league, season, team, fixture, home, away, player } = ctx;
  switch (key) {
    case "status":
    case "timezone":
    case "countries":
    case "leagues.seasons":
    case "teams.countries":
    case "players.seasons":
    case "odds.mapping":
    case "odds.bookmakers":
    case "odds.bets":
    case "odds.live":
    case "odds.live.bets":
      return {};
    case "venues":
      return { country: "England" };
    case "leagues":
      return { id: league };
    case "teams":
      return { league, season };
    case "teams.statistics":
      return team ? { league, season, team } : null;
    case "teams.seasons":
      return team ? { team } : null;
    case "standings":
      return { league, season };
    case "fixtures":
      return { league, season, last: "3" };
    case "fixtures.rounds":
      return { league, season };
    case "fixtures.headtohead":
      return home && away ? { h2h: `${home}-${away}`, last: "5" } : null;
    case "fixtures.statistics":
    case "fixtures.events":
    case "fixtures.lineups":
    case "fixtures.players":
      return fixture ? { fixture } : null;
    case "injuries":
      return { league, season };
    case "predictions":
      return fixture ? { fixture } : null;
    case "sidelined":
      return player ? { player } : null;
    case "coachs":
      return team ? { team } : null;
    case "players":
      return team ? { team, season } : null;
    case "players.profiles":
      return player ? { player } : null;
    case "players.squads":
      return team ? { team } : null;
    case "players.teams":
      return player ? { player } : null;
    case "players.topscorers":
    case "players.topassists":
    case "players.topyellowcards":
    case "players.topredcards":
      return { league, season };
    case "transfers":
      return team ? { team } : null;
    case "trophies":
      return player ? { player } : null;
    case "odds":
      return fixture ? { fixture } : { league, season };
    default:
      // 故意不给 default 兜底成空对象：新端点若忘了登记参数，单测会抓到 undefined
      return undefined as unknown as null;
  }
}

async function readStatus(): Promise<SelftestAccount | null> {
  try {
    const env = await afGet("/status", { force: true });
    return {
      plan: dig(env, "response", "subscription", "plan") as string | undefined,
      active: dig(env, "response", "subscription", "active") as boolean | undefined,
      current: dig(env, "response", "requests", "current") as number | undefined,
      limitDay: dig(env, "response", "requests", "limit_day") as number | undefined,
    };
  } catch {
    return null;
  }
}

/** 解析真实上下文：尽量拿到 fixture/team/player/coach 的真 ID */
async function resolveContext(seed: { league?: string; season?: string }): Promise<SelftestContext> {
  const ctx: SelftestContext = { league: seed.league || "39", season: seed.season || "2023" };
  // 一场已结束的比赛（带主客队 ID）
  try {
    const r = await runAfEndpoint("fixtures", { league: ctx.league, season: ctx.season, last: "10" }, true);
    const arr = Array.isArray(r.response) ? (r.response as Record<string, unknown>[]) : [];
    const fin = arr.find((f) => dig(f, "fixture", "status", "short") === "FT") ?? arr[0];
    if (fin) {
      ctx.fixture = String(dig(fin, "fixture", "id"));
      ctx.home = String(dig(fin, "teams", "home", "id"));
      ctx.away = String(dig(fin, "teams", "away", "id"));
      ctx.team = ctx.home;
    }
  } catch {
    /* 留空，依赖型端点会标 skipped */
  }
  // 球队兜底
  if (!ctx.team) {
    try {
      const r = await runAfEndpoint("teams", { league: ctx.league, season: ctx.season }, true);
      const id = dig(firstArr(r), "team", "id");
      if (id != null) ctx.team = String(id);
    } catch { /* ignore */ }
  }
  // 球员（用阵容名单，不需赛季）
  if (ctx.team) {
    try {
      const r = await runAfEndpoint("players.squads", { team: ctx.team }, true);
      const players = dig(firstArr(r), "players");
      const pid = Array.isArray(players) && players.length > 0 ? dig(players[0], "id") : undefined;
      if (pid != null) ctx.player = String(pid);
    } catch { /* ignore */ }
  }
  // 教练
  if (ctx.team) {
    try {
      const r = await runAfEndpoint("coachs", { team: ctx.team }, true);
      const id = dig(firstArr(r), "id");
      if (id != null) ctx.coach = String(id);
    } catch { /* ignore */ }
  }
  return ctx;
}

export interface SelftestOptions {
  league?: string;
  season?: string;
  /** 端点之间的间隔（毫秒），限流套餐调大，默认 1200 */
  delayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 跑完整自检，返回结构化报告 */
export async function runSelftest(opts: SelftestOptions = {}): Promise<SelftestReport> {
  const delay = opts.delayMs ?? 1200;
  const before = await readStatus();
  const ctx = await resolveContext({ league: opts.league, season: opts.season });

  const rows: SelftestRow[] = [];
  for (const ep of AF_ENDPOINTS) {
    const params = paramsFor(ep.key, ctx);
    if (params === null) {
      rows.push({ key: ep.key, label: ep.label, path: ep.path, status: "skipped", results: 0, note: "依赖 ID 未解析到" });
      continue;
    }
    try {
      const r = await runAfEndpoint(ep.key, params, true);
      if (!r.ok) {
        rows.push({ key: ep.key, label: ep.label, path: r.path, status: "error", results: 0, note: JSON.stringify(r.errors).slice(0, 120) });
      } else {
        rows.push({ key: ep.key, label: ep.label, path: r.path, status: r.results > 0 ? "ok" : "empty", results: r.results });
      }
    } catch (e) {
      rows.push({ key: ep.key, label: ep.label, path: ep.path, status: "error", results: 0, note: e instanceof Error ? e.message : String(e) });
    }
    if (delay > 0) await sleep(delay);
  }

  const after = await readStatus();
  const consumed = before?.current != null && after?.current != null ? after.current - before.current : null;
  const summary = {
    total: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    empty: rows.filter((r) => r.status === "empty").length,
    error: rows.filter((r) => r.status === "error").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
  };
  return { account: after ?? before, consumed, context: ctx, rows, summary };
}

/** 把报告渲染成等宽表格文本（CLI 用） */
export function formatSelftest(rep: SelftestReport): string {
  const lines: string[] = [];
  const a = rep.account;
  lines.push(
    a
      ? `账户：套餐=${a.plan ?? "?"} 活跃=${a.active ?? "?"} 今日已用=${a.current ?? "?"}/${a.limitDay ?? "?"}`
      : "账户：/status 读取失败",
  );
  lines.push(`本次净消耗请求数：${rep.consumed ?? "?"}`);
  const c = rep.context;
  lines.push(`上下文：league=${c.league} season=${c.season} fixture=${c.fixture ?? "—"} team=${c.team ?? "—"} player=${c.player ?? "—"} coach=${c.coach ?? "—"}`);
  lines.push("");

  const icon = { ok: "✓", empty: "·", error: "✗", skipped: "—" } as const;
  const kw = Math.max(...rep.rows.map((r) => r.key.length), 4);
  for (const r of rep.rows) {
    const head = `${icon[r.status]} ${r.key.padEnd(kw)}  ${String(r.results).padStart(4)}  ${r.label}`;
    lines.push(r.note ? `${head}  «${r.note}»` : head);
  }
  lines.push("");
  const s = rep.summary;
  lines.push(`合计 ${s.total}：✓回数据 ${s.ok} · ·空 ${s.empty} · ✗报错 ${s.error} · —跳过 ${s.skipped}`);
  return lines.join("\n");
}
