/** 抓取分层(设计稿对接注释逐字口径) */
import { describe, expect, it } from "vitest";
import { freshLine, mustForce, tierFor } from "../../src/server/af/schedule";

const M = 60_000;
const now = Date.parse("2026-06-11T12:00:00Z");
const ko = (minsAhead: number) => now + minsAhead * M;

describe("tierFor", () => {
  it(">12h 低频巡检 → 开球前逐级加密 → 滚球 1min", () => {
    expect(tierFor(ko(13 * 60), now, "NS").freq).toBe("低频巡检");
    expect(tierFor(ko(8 * 60), now, "NS").freq).toBe("每 60 分钟");
    expect(tierFor(ko(3 * 60), now, "NS").freq).toBe("每 30 分钟");
    expect(tierFor(ko(45), now, "NS").freq).toBe("每 10 分钟");
    expect(tierFor(ko(20), now, "NS").freq).toBe("每 5 分钟");
    expect(tierFor(ko(3), now, "NS").freq).toBe("每 1 分钟");
    expect(tierFor(ko(-10), now, "1H").idx).toBe(6);
    expect(tierFor(ko(-10), now, "HT").idx).toBe(6);
  });

  it("完场回落低频;名义已开球但状态未翻转按滚球频率盯", () => {
    expect(tierFor(ko(-200), now, "FT").idx).toBe(0);
    expect(tierFor(ko(-2), now, "NS").idx).toBe(6);
  });
});

describe("mustForce(绕 10min TTL 缓存边界)", () => {
  it("滚球与 T-30min 内必须 force", () => {
    expect(mustForce(ko(20), now, "NS")).toBe(true);
    expect(mustForce(ko(3), now, "NS")).toBe(true);
    expect(mustForce(ko(-10), now, "1H")).toBe(true);
    expect(mustForce(ko(45), now, "NS")).toBe(false);
    expect(mustForce(ko(8 * 60), now, "NS")).toBe(false);
  });
});

describe("freshLine(详情页提示行)", () => {
  it("滚球/完场/赛前各有文案", () => {
    expect(freshLine(ko(-10), now, "1H").line).toContain("滚球");
    expect(freshLine(ko(-200), now, "FT").line).toContain("完场");
    expect(freshLine(ko(45), now, "NS").line).toContain("距开赛约 45 分钟");
  });
});
