/**
 * 账户额度账务:所有变动走 ledger(kind+delta+balance),服务端唯一记账。
 * 解锁永久可见;每日免费场对登录用户视同已解锁(不落 unlocks 行)。
 */
import { db, tx } from "../db";
import { rechargeCredit } from "./rules";
import { cfgFirstBonusOn, cfgGiftPoints, cfgInviteCaps, cfgInvitePoints, cfgRechargeTiers, cfgUnlockPrice } from "./config";

export type WalletResult = { ok: true; pts: number; note?: string } | { ok: false; error: string };

function append(userId: number, kind: string, delta: number, note: string, rmb: number | null = null): number {
  const d = db();
  const u = d.prepare("SELECT pts FROM users WHERE id = ?").get(userId) as { pts: number } | undefined;
  if (!u) throw new Error("用户不存在");
  const balance = u.pts + delta;
  if (balance < 0) throw new Error("余额不足");
  d.prepare("UPDATE users SET pts = ? WHERE id = ?").run(balance, userId);
  d.prepare("INSERT INTO ledger (user_id, kind, delta, balance, note, created_at, rmb) VALUES (?,?,?,?,?,?,?)").run(
    userId, kind, delta, balance, note, Date.now(), rmb,
  );
  return balance;
}

/** 后台调额度(补偿/扣减),由调用方做 RBAC 与审计 */
export function adjustPoints(userId: number, delta: number, reason: string, afterAppend?: (pts: number) => void): WalletResult {
  return tx(() => {
    const pts = append(userId, "adjust", delta, reason || "后台调整");
    afterAppend?.(pts);
    return { ok: true as const, pts };
  });
}

export function balanceOf(userId: number): number {
  const u = db().prepare("SELECT pts FROM users WHERE id = ?").get(userId) as { pts: number } | undefined;
  return u?.pts ?? 0;
}

export function demoRechargeEnabled(): boolean {
  return process.env.PLAYTOP_DEMO_RECHARGE === "1" || process.env.NODE_ENV !== "production";
}

/** 新人礼包 +58(一次性) */
export function claimGift(userId: number): WalletResult {
  return tx(() => {
    const d = db();
    const u = d.prepare("SELECT gift_claimed FROM users WHERE id = ?").get(userId) as { gift_claimed: number } | undefined;
    if (!u) return { ok: false as const, error: "用户不存在" };
    if (u.gift_claimed) return { ok: false as const, error: "礼包已领取" };
    d.prepare("UPDATE users SET gift_claimed = 1 WHERE id = ?").run(userId);
    return { ok: true as const, pts: append(userId, "gift", cfgGiftPoints(), "新人礼包") };
  });
}

/** 购买额度:仅在显式开关允许时直接记账;接入支付网关后在此校验回调 */
export function recharge(userId: number, tierIndex: number): WalletResult {
  if (!demoRechargeEnabled()) return { ok: false, error: "购买额度通道维护中,请稍后再试" };
  const tier = cfgRechargeTiers()[tierIndex];
  if (!tier) return { ok: false, error: "档位不存在" };
  return tx(() => {
    const d = db();
    const u = d.prepare("SELECT first_recharged FROM users WHERE id = ?").get(userId) as { first_recharged: number } | undefined;
    if (!u) return { ok: false as const, error: "用户不存在" };
    const isFirst = !u.first_recharged && cfgFirstBonusOn();
    const credit = rechargeCredit(tier, isFirst);
    d.prepare("UPDATE users SET first_recharged = 1 WHERE id = ?").run(userId);
    const note = `购买额度 ¥${tier.rmb}` + (isFirst ? "(首购 +50%)" : "");
    return { ok: true as const, pts: append(userId, "recharge", credit, note, tier.rmb), note };
  });
}

/** 兑换码:每码每用户限一次,码本身有总次数上限 */
export function redeem(userId: number, codeRaw: string, ip: string | null = null): WalletResult {
  const code = codeRaw.trim().toUpperCase();
  if (!code) return { ok: false, error: "请输入兑换码" };
  return tx(() => {
    const d = db();
    const c = d.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code) as
      | { code: string; points: number; max_uses: number; used_count: number; expires_at: number | null }
      | undefined;
    if (!c || (c.expires_at && c.expires_at < Date.now())) return { ok: false as const, error: "兑换码无效或已过期" };
    if (c.used_count >= c.max_uses) return { ok: false as const, error: "兑换码已被领完" };
    if (d.prepare("SELECT 1 FROM redemptions WHERE code = ? AND user_id = ?").get(code, userId))
      return { ok: false as const, error: "该兑换码已使用" };
    d.prepare("INSERT INTO redemptions (code, user_id, created_at, ip) VALUES (?,?,?,?)").run(code, userId, Date.now(), ip);
    d.prepare("UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?").run(code);
    return { ok: true as const, pts: append(userId, "redeem", c.points, `兑换码 ${code}`), note: `+${c.points}` };
  });
}

/** 当日免费场列表(平台指定,可多场;登录即视同解锁) */
export function dailyFreeFixtureIds(dateStr: string): number[] {
  const rows = db().prepare("SELECT fixture_id FROM free_fixtures WHERE date = ? ORDER BY fixture_id").all(dateStr) as unknown as {
    fixture_id: number;
  }[];
  return rows.map((r) => r.fixture_id);
}

/** 兼容旧调用:返回当日第一个免费场 */
export function dailyFreeFixture(dateStr: string): number | null {
  return dailyFreeFixtureIds(dateStr)[0] ?? null;
}

export function isUnlocked(userId: number, fixtureId: number, dateStr: string): boolean {
  if (dailyFreeFixtureIds(dateStr).includes(fixtureId)) return true;
  return !!db().prepare("SELECT 1 FROM unlocks WHERE user_id = ? AND fixture_id = ?").get(userId, fixtureId);
}

/** 解锁 AI 概率报告:价格按开球时间由服务端定(赛前 38 / 开赛后 58) */
export function unlock(userId: number, fixtureId: number, kickoffUtcMs: number, matchName: string, dateStr: string): WalletResult {
  return tx(() => {
    if (isUnlocked(userId, fixtureId, dateStr)) return { ok: false as const, error: "本场已解锁" };
    const price = cfgUnlockPrice(kickoffUtcMs, Date.now());
    if (balanceOf(userId) < price) return { ok: false as const, error: "余额不足" };
    db().prepare("INSERT INTO unlocks (user_id, fixture_id, price, created_at) VALUES (?,?,?,?)").run(
      userId, fixtureId, price, Date.now(),
    );
    return { ok: true as const, pts: append(userId, "unlock", -price, `解锁 ${matchName}`) };
  });
}

export function unlockedIds(userId: number): number[] {
  return (db().prepare("SELECT fixture_id FROM unlocks WHERE user_id = ?").all(userId) as { fixture_id: number }[]).map(
    (r) => r.fixture_id,
  );
}

export function ledgerOf(userId: number, limit = 200): { kind: string; delta: number; note: string; created_at: number }[] {
  return db()
    .prepare("SELECT kind, delta, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as { kind: string; delta: number; note: string; created_at: number }[];
}

/** 邀请记分(注册成功时由 auth 调用);超日/周/月上限部分不计 */
export function creditInvite(inviterId: number, inviteeId: number, ip: string | null = null): number {
  const d = db();
  const now = Date.now();
  const caps = cfgInviteCaps();
  const count = (sinceMs: number) =>
    (d.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND credited > 0 AND created_at >= ?").get(inviterId, sinceMs) as { n: number }).n;
  const within = { day: count(startOfDay(now)), week: count(startOfWeek(now)), month: count(startOfMonth(now)) };
  const credit = within.day >= caps.day || within.week >= caps.week || within.month >= caps.month ? 0 : cfgInvitePoints();
  d.prepare("INSERT INTO invites (inviter_id, invitee_id, credited, created_at, ip) VALUES (?,?,?,?,?)").run(
    inviterId, inviteeId, credit, now, ip,
  );
  if (credit > 0) append(inviterId, "invite", credit, "邀请好友注册");
  return credit;
}

export function inviteStats(userId: number): { day: number; week: number; month: number; total: number; totalPts: number } {
  const d = db();
  const now = Date.now();
  const count = (sinceMs: number) =>
    (d.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND credited > 0 AND created_at >= ?").get(userId, sinceMs) as { n: number }).n;
  const total = (d.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ?").get(userId) as { n: number }).n;
  const totalPts = (d.prepare("SELECT COALESCE(SUM(credited),0) AS n FROM invites WHERE inviter_id = ?").get(userId) as { n: number }).n;
  return { day: count(startOfDay(now)), week: count(startOfWeek(now)), month: count(startOfMonth(now)), total, totalPts };
}

/* 邀请上限的统计窗口按 UTC+8(平台运营时区)对齐 */
const TZ8 = 8 * 3_600_000;
export function startOfDay(nowMs: number): number {
  return Math.floor((nowMs + TZ8) / 86_400_000) * 86_400_000 - TZ8;
}
export function startOfWeek(nowMs: number): number {
  const d = new Date(nowMs + TZ8);
  const dow = (d.getUTCDay() + 6) % 7; // 周一为一周起点
  return startOfDay(nowMs) - dow * 86_400_000;
}
export function startOfMonth(nowMs: number): number {
  const d = new Date(nowMs + TZ8);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ8;
}
