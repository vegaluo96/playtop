import { describe, expect, it } from "vitest";

import { buildReportSignals, hasUsableProbability } from "../../src/server/views/report-signals";
import type { PredSummary } from "../../src/server/views/common";

function ps(overrides: Partial<PredSummary> = {}): PredSummary {
  return {
    pH: 58,
    pD: 22,
    pA: 20,
    winnerName: "A",
    winnerHome: true,
    winDraw: false,
    advice: "概率倾向:A",
    uoLine: "2.5",
    uoText: "大于 2.5 球",
    goalsHome: "2",
    goalsAway: "1",
    comparison: { 综合: { home: 60, away: 40 } },
    formHome: "",
    formAway: "",
    derived: false,
    ...overrides,
  };
}

describe("AI 报告量化方向", () => {
  it("概率壳数据不当成可用概率", () => {
    expect(hasUsableProbability(ps({ pH: 33, pD: 33, pA: 33, winnerName: "", uoText: null, comparison: { 综合: { home: 0, away: 0 } } }))).toBe(false);
  });

  it("用 AF 预测、赛前指数和预测市场动态加权生成 AH/OU 方向", () => {
    const sig = buildReportSignals(
      ps(),
      {
        ah: [{ fixture_id: 1, bookmaker_id: 8, bookmaker: "Bet365", market: "ah", line: 0.5, h: 0.86, a: 1.02, d: null, captured_at: 1000 }],
        ou: [{ fixture_id: 1, bookmaker_id: 8, bookmaker: "Bet365", market: "ou", line: 2.5, h: 0.84, a: 1.04, d: null, captured_at: 1000 }],
      },
      { status: "ok", note: "ok", source: "Polymarket", side: "home" },
    );

    expect(sig.ah.text).toContain("主队方向");
    expect(sig.ou.text).toContain("大于");
    expect(sig.model.coverage).toBeGreaterThan(55);
    expect(sig.model.inputs.filter((x) => x.status === "used").length).toBeGreaterThan(3);
  });

  it("没有真实信号时保持 OPEN,不硬给方向", () => {
    const sig = buildReportSignals(
      ps({ pH: 0, pD: 0, pA: 0, winnerName: "", uoText: null, goalsHome: null, goalsAway: null, comparison: { 综合: { home: 0, away: 0 } } }),
      { ah: [], ou: [] },
    );

    expect(sig.ah.status).toBe("open");
    expect(sig.ou.status).toBe("open");
    expect(sig.model.ahScore).toBeNull();
  });
});
