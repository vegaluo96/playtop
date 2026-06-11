/**
 * 平台动态配置(后台可改,kv `cfg:*` 持久化):
 * 读取顺序 kv → env → rules.ts 静态默认;未配置时行为与原静态规则完全一致。
 */
import { kvGet, kvSet } from "../af/store";
import { GIFT_POINTS, INVITE_CAPS, INVITE_POINTS, PRICE_LIVE, PRICE_PRE, RECHARGE_TIERS, type RechargeTier } from "./rules";
import { LEAGUES } from "@/lib/leagues";
import { TIERS } from "../af/schedule";

function num(key: string, fallback: number): number {
  const v = kvGet(`cfg:${key}`);
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function json<T>(key: string, fallback: T): T {
  const v = kvGet(`cfg:${key}`);
  if (v == null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
export function cfgSet(key: string, value: unknown): void {
  kvSet(`cfg:${key}`, typeof value === "string" ? value : JSON.stringify(value));
}
export function cfgGetRaw(key: string): string | null {
  return kvGet(`cfg:${key}`);
}

/* ── 商业规则(营销配置页可改)── */
export const cfgPricePre = () => num("price_pre", PRICE_PRE);
export const cfgPriceLive = () => num("price_live", PRICE_LIVE);
export const cfgGiftPoints = () => num("gift_points", GIFT_POINTS);
export const cfgInvitePoints = () => num("invite_points", INVITE_POINTS);
export const cfgInviteCaps = () => json("invite_caps", INVITE_CAPS as { day: number; week: number; month: number });
export const cfgRechargeTiers = (): RechargeTier[] => json("recharge_tiers", RECHARGE_TIERS);
export const cfgFirstBonusOn = () => num("first_bonus_on", 1) === 1;

export function cfgUnlockPrice(kickoffUtcMs: number, nowMs: number): number {
  return nowMs >= kickoffUtcMs ? cfgPriceLive() : cfgPricePre();
}

/* ── 联赛开关(赛事与内容页)── */
export interface LeagueCfg {
  id: number;
  zh: string;
  color: string;
  on: boolean;
  wc?: boolean;
}
export function cfgLeagues(): LeagueCfg[] {
  return json(
    "leagues",
    LEAGUES.map((l) => ({ id: l.id, zh: l.zh, color: l.color, on: true, wc: l.wc })),
  );
}
export function cfgFollowedIds(): number[] {
  return cfgLeagues().filter((l) => l.on).map((l) => l.id);
}

/* ── 抓取分层(数据监控页可改;1min 为 API-SPORTS 下限,不可更低)── */
export function cfgTierIntervals(): number[] {
  const def = TIERS.map((t) => t.intervalMs);
  const v = json<number[]>("tier_intervals", def);
  return v.length === def.length ? v.map((ms, i) => Math.max(i >= 5 ? 60_000 : ms, 60_000)) : def;
}
export const cfgEmergencyThrottle = () => num("emergency_throttle", 0) === 1;

/* ── 密钥(系统设置页;仅掩码回显)── */
export const cfgAfKey = () => cfgGetRaw("af_key") || process.env.API_FOOTBALL_KEY?.trim() || null;
export const cfgLlmKey = () => cfgGetRaw("llm_key") || process.env.LLM_API_KEY?.trim() || null;
export const cfgLlmBalanceKey = () => cfgGetRaw("llm_balance_key") || process.env.BALANCE_QUERY_KEY?.trim() || null;
export const cfgLlmBase = () => cfgGetRaw("llm_base") || process.env.LLM_BASE_URL || "https://api.apiyi.com/v1";
export const cfgLlmModel = () => cfgGetRaw("llm_model") || process.env.LLM_MODEL || "claude-sonnet-4-5-20250929";
export const cfgLlmDailyBudget = () => num("llm_daily_budget", 10_000_000);

export function maskKey(key: string | null): string {
  if (!key) return "未配置";
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}••••••••••••${key.slice(-4)}`;
}
