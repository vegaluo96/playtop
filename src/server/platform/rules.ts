/**
 * 商业规则(HANDOFF §2,必须严格实现;纯函数+常量,单测保证)。
 * 唯一收费项 = 预测(含 AI 报告):赛前 38 积分/场,开赛后 58;
 * 每日 1 场平台指定免费分析;解锁永久可见(服务端记账)。
 */

export const GIFT_POINTS = 58;
export const PRICE_PRE = 38;
export const PRICE_LIVE = 58;
export const INVITE_POINTS = 1;
export const INVITE_CAPS = { day: 10, week: 30, month: 100 } as const;
export const FIRST_RECHARGE_BONUS = 0.5;

export interface RechargeTier {
  rmb: number;
  pts: number;
  tag?: string;
  hot?: boolean;
}

/** 充值档位:¥6/60 … ¥648/8420(+30%,最划算) */
export const RECHARGE_TIERS: RechargeTier[] = [
  { rmb: 6, pts: 60 },
  { rmb: 30, pts: 320, tag: "+6%" },
  { rmb: 68, pts: 750, tag: "+10%" },
  { rmb: 128, pts: 1480, tag: "+15%" },
  { rmb: 328, pts: 3940, tag: "+20%" },
  { rmb: 648, pts: 8420, tag: "+30%", hot: true },
];

/** 解锁价:以开球时间为界(开赛后含滚球/完场均 58) */
export function unlockPrice(kickoffUtcMs: number, nowMs: number): number {
  return nowMs >= kickoffUtcMs ? PRICE_LIVE : PRICE_PRE;
}

/** 首充加赠(任意档位 +50%,向下取整) */
export function rechargeCredit(tier: RechargeTier, isFirst: boolean): number {
  return isFirst ? tier.pts + Math.floor(tier.pts * FIRST_RECHARGE_BONUS) : tier.pts;
}

/**
 * 邀请记分:given 当前日/周/月已记数,返回本次应记积分(0=超上限不计)。
 */
export function inviteCredit(counts: { day: number; week: number; month: number }): number {
  if (counts.day >= INVITE_CAPS.day) return 0;
  if (counts.week >= INVITE_CAPS.week) return 0;
  if (counts.month >= INVITE_CAPS.month) return 0;
  return INVITE_POINTS;
}

/** 邀请码:无歧义字母表(去 0O1I),8 位 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genInviteCode(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/**
 * 免注册可浏览边界(列表/异动:前 N 条完整 + 直播完整,其余打码):
 * index 为该列表内的序号(0 起),live 行不打码。
 */
export const GUEST_VISIBLE_ROWS = 3;
export function guestMasked(index: number, isLive: boolean): boolean {
  return !isLive && index >= GUEST_VISIBLE_ROWS;
}

/** 邀请记录展示用:邮箱脱敏(local 部分留首尾各 2 字,如 smoke→sm**ke) */
export function maskEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (local.length <= 2) return `${local[0] ?? "*"}**`;
  if (local.length <= 4) return `${local.slice(0, 1)}**${local.slice(-1)}`;
  return `${local.slice(0, 2)}**${local.slice(-2)}`;
}
