/** 账务链路(内存库):注册礼包/购买额度/兑换/解锁/邀请记分/流水 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import { loginOrRegister, upsertSystemUser, userByToken } from "../../src/server/platform/auth";
import {
  balanceOf,
  claimGift,
  creditInvite,
  dailyFreeFixture,
  dailyFreeFixtureIds,
  demoRechargeEnabled,
  inviteStats,
  isUnlocked,
  ledgerOf,
  recharge,
  redeem,
  unlock,
} from "../../src/server/platform/wallet";

function newUser(email: string): number {
  const r = loginOrRegister(email, "secret66");
  if (!r.ok) throw new Error(r.error);
  return r.user.id;
}

beforeEach(() => {
  _resetDbForTest();
});

describe("账户", () => {
  it("未注册邮箱自动建号;密码错误拒绝;会话可取回用户", () => {
    const r1 = loginOrRegister("a@b.com", "secret66");
    expect(r1.ok && r1.created).toBe(true);
    const r2 = loginOrRegister("a@b.com", "wrongpass");
    expect(r2.ok).toBe(false);
    const r3 = loginOrRegister("a@b.com", "secret66");
    expect(r3.ok && !r3.created).toBe(true);
    if (r3.ok) expect(userByToken(r3.token)?.email).toBe("a@b.com");
  });

  it("密码至少 6 位、邮箱格式校验", () => {
    expect(loginOrRegister("bad", "secret66").ok).toBe(false);
    expect(loginOrRegister("a@b.com", "12345").ok).toBe(false);
  });

  it("ADMIN_EMAIL 为系统保留账号,seed 路径会创建/重置密码", () => {
    const oldAdmin = process.env.ADMIN_EMAIL;
    try {
      process.env.ADMIN_EMAIL = "root@b.com";
      expect(loginOrRegister("root@b.com", "attacker66")).toMatchObject({ ok: false });
      const u = upsertSystemUser("root@b.com", "seedpass");
      expect(u?.email).toBe("root@b.com");
      expect(loginOrRegister("root@b.com", "attacker66").ok).toBe(false);
      expect(loginOrRegister("root@b.com", "seedpass").ok).toBe(true);
    } finally {
      if (oldAdmin == null) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = oldAdmin;
    }
  });
});

describe("礼包与购买额度", () => {
  it("礼包 +58 仅一次", () => {
    const uid = newUser("g@b.com");
    expect(claimGift(uid)).toMatchObject({ ok: true, pts: 58 });
    expect(claimGift(uid).ok).toBe(false);
    expect(balanceOf(uid)).toBe(58);
  });

  it("首购 +50%,二次购买原值,流水完整", () => {
    const uid = newUser("r@b.com");
    expect(recharge(uid, 0)).toMatchObject({ ok: true, pts: 90 });
    expect(recharge(uid, 0)).toMatchObject({ ok: true, pts: 150 });
    const ledger = ledgerOf(uid);
    expect(ledger).toHaveLength(2);
    expect(ledger[1].note).toContain("首购");
  });

  it("生产环境默认关闭演示购买额度,显式开关才允许", () => {
    const oldEnv = process.env.NODE_ENV;
    const oldDemo = process.env.PLAYTOP_DEMO_RECHARGE;
    const env = process.env as Record<string, string | undefined>;
    try {
      env.NODE_ENV = "production";
      delete env.PLAYTOP_DEMO_RECHARGE;
      const uid = newUser("prod-pay@b.com");
      expect(demoRechargeEnabled()).toBe(false);
      expect(recharge(uid, 0)).toMatchObject({ ok: false });
      env.PLAYTOP_DEMO_RECHARGE = "1";
      expect(demoRechargeEnabled()).toBe(true);
      expect(recharge(uid, 0)).toMatchObject({ ok: true, pts: 90 });
    } finally {
      if (oldEnv == null) delete env.NODE_ENV;
      else env.NODE_ENV = oldEnv;
      if (oldDemo == null) delete env.PLAYTOP_DEMO_RECHARGE;
      else env.PLAYTOP_DEMO_RECHARGE = oldDemo;
    }
  });
});

describe("兑换码", () => {
  it("有效码到账;同人重复使用拒绝;次数用尽拒绝", () => {
    db().prepare("INSERT INTO redeem_codes (code, points, max_uses) VALUES ('WC2026', 100, 2)").run();
    const u1 = newUser("c1@b.com");
    const u2 = newUser("c2@b.com");
    const u3 = newUser("c3@b.com");
    expect(redeem(u1, "wc2026")).toMatchObject({ ok: true, pts: 100 });
    expect(redeem(u1, "WC2026").ok).toBe(false);
    expect(redeem(u2, "WC2026").ok).toBe(true);
    expect(redeem(u3, "WC2026").ok).toBe(false);
    expect(redeem(u3, "NOPE").ok).toBe(false);
  });
});

describe("解锁(唯一收费项)", () => {
  const ko = (offsetMin: number) => Date.now() + offsetMin * 60_000;

  it("赛前 38 扣费、永久可见、重复解锁拒绝", () => {
    const uid = newUser("u@b.com");
    claimGift(uid);
    const r = unlock(uid, 1001, ko(120), "A vs B", "2026-06-11");
    expect(r).toMatchObject({ ok: true, pts: 20 });
    expect(isUnlocked(uid, 1001, "2026-06-11")).toBe(true);
    expect(unlock(uid, 1001, ko(120), "A vs B", "2026-06-11").ok).toBe(false);
  });

  it("余额不足拒绝;开赛后按 58 计价", () => {
    const uid = newUser("u2@b.com");
    claimGift(uid); // 58
    expect(unlock(uid, 1002, ko(-10), "A vs B", "2026-06-11")).toMatchObject({ ok: true, pts: 0 });
    expect(unlock(uid, 1003, ko(120), "C vs D", "2026-06-11").ok).toBe(false);
  });

  it("每日免费场对登录用户视同已解锁;支持同日多场", () => {
    const uid = newUser("u3@b.com");
    db().prepare("INSERT INTO free_fixtures (date, fixture_id) VALUES ('2026-06-11', 7777)").run();
    db().prepare("INSERT INTO free_fixtures (date, fixture_id) VALUES ('2026-06-11', 8888)").run();
    expect(dailyFreeFixture("2026-06-11")).toBe(7777);
    expect(dailyFreeFixtureIds("2026-06-11")).toEqual([7777, 8888]);
    expect(isUnlocked(uid, 7777, "2026-06-11")).toBe(true);
    expect(isUnlocked(uid, 8888, "2026-06-11")).toBe(true); // 第二场同样免费
    expect(unlock(uid, 7777, ko(60), "E vs F", "2026-06-11").ok).toBe(false); // 已免费,不允许重复扣费
  });
});

describe("邀请记分", () => {
  it("注册归因自动 +1;统计窗口正确", () => {
    const inviter = loginOrRegister("inv@b.com", "secret66");
    if (!inviter.ok) throw new Error("注册失败");
    const code = inviter.user.invite_code;
    const invitee = loginOrRegister("new@b.com", "secret66", code);
    expect(invitee.ok).toBe(true);
    expect(balanceOf(inviter.user.id)).toBe(1);
    const s = inviteStats(inviter.user.id);
    expect(s).toMatchObject({ day: 1, week: 1, month: 1, total: 1, totalPts: 1 });
  });

  it("超过日上限的邀请记录在案但不计分", () => {
    const uid = newUser("cap@b.com");
    for (let i = 0; i < 12; i++) creditInvite(uid, 9000 + i);
    expect(balanceOf(uid)).toBe(10);
    const s = inviteStats(uid);
    expect(s.total).toBe(12);
    expect(s.totalPts).toBe(10);
  });
});
