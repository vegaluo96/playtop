import { describe, expect, it } from "vitest";
import { normalizeSearchText, scoreSearchFields } from "../../src/lib/search";

describe("统一搜索匹配", () => {
  it("归一化中英文符号并支持紧凑匹配", () => {
    expect(normalizeSearchText("加拿大 vs 波黑 · 让球/半球")).toBe("加拿大 vs 波黑 让球 半球");
    expect(scoreSearchFields("加拿大波黑", [{ value: "加拿大 vs 波黑", weight: 4 }])).toBeGreaterThan(0);
  });

  it("多关键词必须全部命中,标题命中优先于普通关键词", () => {
    const titleHit = scoreSearchFields("美国 世界杯", [
      { value: "美国 vs 巴拉圭", weight: 4 },
      { value: "世界杯", weight: 2 },
    ]);
    const keywordOnly = scoreSearchFields("美国 世界杯", [
      { value: "友谊赛", weight: 4 },
      { value: "美国 世界杯", weight: 1 },
    ]);

    expect(titleHit).toBeGreaterThan(keywordOnly);
    expect(scoreSearchFields("美国 英超", [{ value: "美国 vs 巴拉圭", weight: 4 }, { value: "世界杯", weight: 2 }])).toBe(0);
  });
});
