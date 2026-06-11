/** 展示格式化:开球日前缀(今日/明日/昨日/MM-DD,按用户时区切日) */
import { describe, expect, it } from "vitest";
import { dayLabel } from "../../src/lib/format";

const now = Date.parse("2026-06-11T12:00:00Z"); // UTC+8 = 06-11 20:00

describe("dayLabel", () => {
  it("同日/次日/前日/更远日期", () => {
    expect(dayLabel(now + 2 * 3_600_000, "UTC+8", now)).toBe("今日"); // 22:00 当天
    expect(dayLabel(now + 6 * 3_600_000, "UTC+8", now)).toBe("明日"); // 跨 0 点
    expect(dayLabel(now - 22 * 3_600_000, "UTC+8", now)).toBe("昨日");
    expect(dayLabel(now + 50 * 3_600_000, "UTC+8", now)).toBe("06-13");
  });

  it("时区影响切日:UTC+0 下 20:00+6h 仍是同日", () => {
    expect(dayLabel(now + 6 * 3_600_000, "UTC+0", now)).toBe("今日"); // UTC 12:00 → 18:00
  });
});
