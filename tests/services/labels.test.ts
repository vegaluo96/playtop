import { describe, expect, it } from "vitest";

import { selectionLabel } from "@/server/llm/reportWriter";

describe("亚盘标签方向换算（line 全站为主队让球口径）", () => {
  it("客队侧展示其自身盘口：主让 -1.5 的客队侧 = 客队 +1.5", () => {
    expect(selectionLabel("ah", "home", -1.5)).toBe("主队盘口 -1.5");
    expect(selectionLabel("ah", "away", -1.5)).toBe("客队盘口 +1.5");
    expect(selectionLabel("ah", "home", 0.25)).toBe("主队盘口 +0.25");
    expect(selectionLabel("ah", "away", 0.25)).toBe("客队盘口 -0.25");
    expect(selectionLabel("ah", "home", 0)).toBe("主队盘口 0");
    expect(selectionLabel("ah", "away", 0)).toBe("客队盘口 0");
  });

  it("胜平负与大小球标签不受影响", () => {
    expect(selectionLabel("1x2", "home", null)).toBe("主胜");
    expect(selectionLabel("ou", "over", 2.5)).toBe("大球 2.5");
    expect(selectionLabel("ou", "under", 3)).toBe("小球 3");
  });
});
