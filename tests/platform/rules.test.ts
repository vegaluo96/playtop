import { describe, expect, it } from "vitest";
import {
  GIFT_POINTS,
  GUEST_VISIBLE_ROWS,
  INVITE_CAPS,
  RECHARGE_TIERS,
  genInviteCode,
  guestMasked,
  inviteCredit,
  maskEmail,
  rechargeCredit,
  unlockPrice,
} from "../../src/server/platform/rules";

describe("商业规则(HANDOFF §2 严格口径)", () => {
  it("解锁价:赛前 38 / 开赛后(含滚球与完场)58", () => {
    const ko = Date.parse("2026-06-11T19:00:00Z");
    expect(unlockPrice(ko, ko - 1)).toBe(38);
    expect(unlockPrice(ko, ko)).toBe(58);
    expect(unlockPrice(ko, ko + 3_600_000)).toBe(58);
  });

  it("新人礼包 58 积分", () => {
    expect(GIFT_POINTS).toBe(58);
  });

  it("充值档位:¥6/60 起,¥648/8420 为最划算档", () => {
    expect(RECHARGE_TIERS[0]).toMatchObject({ rmb: 6, pts: 60 });
    const top = RECHARGE_TIERS[RECHARGE_TIERS.length - 1];
    expect(top).toMatchObject({ rmb: 648, pts: 8420, hot: true });
  });

  it("首充 +50%(向下取整),非首充原值", () => {
    expect(rechargeCredit(RECHARGE_TIERS[0], true)).toBe(90);
    expect(rechargeCredit(RECHARGE_TIERS[0], false)).toBe(60);
    expect(rechargeCredit(RECHARGE_TIERS[5], true)).toBe(8420 + 4210);
  });

  it("邀请上限:日 10 / 周 30 / 月 100,超限不计", () => {
    expect(INVITE_CAPS).toEqual({ day: 10, week: 30, month: 100 });
    expect(inviteCredit({ day: 0, week: 0, month: 0 })).toBe(1);
    expect(inviteCredit({ day: 10, week: 10, month: 10 })).toBe(0);
    expect(inviteCredit({ day: 0, week: 30, month: 30 })).toBe(0);
    expect(inviteCredit({ day: 0, week: 0, month: 100 })).toBe(0);
  });

  it("免注册:列表前 3 行完整 + 直播完整,其余打码", () => {
    expect(GUEST_VISIBLE_ROWS).toBe(3);
    expect(guestMasked(0, false)).toBe(false);
    expect(guestMasked(2, false)).toBe(false);
    expect(guestMasked(3, false)).toBe(true);
    expect(guestMasked(99, true)).toBe(false);
  });

  it("邀请码:8 位、无歧义字母表", () => {
    const code = genInviteCode();
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("邮箱脱敏:留 local 首尾,不泄露完整地址", () => {
    expect(maskEmail("smoke@test.com")).toBe("sm**ke");
    expect(maskEmail("abcd@x.com")).toBe("a**d");
    expect(maskEmail("ab@x.com")).toBe("a**");
    expect(maskEmail("vegaluo96@gmail.com")).toBe("ve**96");
  });
});
