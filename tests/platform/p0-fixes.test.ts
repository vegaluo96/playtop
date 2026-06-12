/** P0 修复回归:书商打码 / AI 概率报告指数派生观点 / LLM 余额查询窗口 */
import { describe, expect, it } from "vitest";
import { maskBookmaker } from "../../src/lib/format";
import { predSummary } from "../../src/server/views/common";
import { llmUsageWindow } from "../../src/server/llm/client";

describe("maskBookmaker(前台不显示全称但保留辨识度)", () => {
  it("英文保留前 2 + 末 1", () => {
    expect(maskBookmaker("Bet365")).toBe("Be***5");
    expect(maskBookmaker("1xBet")).toBe("1x***t");
    expect(maskBookmaker("Bwin")).toBe("Bw***n");
  });
  it("中文保留首字", () => {
    expect(maskBookmaker("平博")).toBe("平*");
    expect(maskBookmaker("威廉希尔")).toBe("威***");
    expect(maskBookmaker("必发")).toBe("必*");
  });
  it("超短名安全处理", () => {
    expect(maskBookmaker("AB")).toBe("A**");
    expect(maskBookmaker("")).toBe("");
  });
});

describe("predSummary 指数派生观点(AF 模型缺方向时不误称官方方向)", () => {
  const emptyPred = { predictions: { percent: { home: "40%", draw: "30%", away: "30%" } } };

  it("AF winner 缺失 → 让球方向派生,标注指数派生观点", () => {
    const ps = predSummary(emptyPred, 50, {
      ah: { line: 0.5, h: 0.95, a: 0.91 },
      ou: { line: 2.5, h: 0.88, a: 0.98 },
      homeName: "Mexico", awayName: "South Africa",
    })!;
    expect(ps.derived).toBe(true);
    expect(ps.winnerName).toBe("Mexico"); // 主让半球 → 主队方向
    expect(ps.winnerHome).toBe(true);
    expect(ps.uoText).toBe("大于 2.5 球"); // 大球水位更低 → 市场倾向大
    expect(ps.advice).toContain("指数派生观点");
  });

  it("受让盘 → 客队方向", () => {
    const ps = predSummary(emptyPred, 50, { ah: { line: -0.75, h: 0.92, a: 0.94 }, awayName: "Japan" })!;
    expect(ps.winnerName).toBe("Japan");
    expect(ps.winnerHome).toBe(false);
  });

  it("AF 字段齐全时不动原值、不标注派生", () => {
    const full = {
      predictions: {
        winner: { id: 50, name: "Man City" }, win_or_draw: false, under_over: "-2.5",
        percent: { home: "58%", draw: "22%", away: "20%" },
      },
    };
    const ps = predSummary(full, 50, { ah: { line: -1, h: 0.9, a: 0.96 } })!;
    expect(ps.derived).toBe(false);
    expect(ps.winnerName).toBe("Man City");
    expect(ps.advice).not.toContain("指数派生观点");
  });

  it("平手盘且无水位差 → 不强行给方向", () => {
    const ps = predSummary(emptyPred, 50, { ah: { line: 0, h: 0.93, a: 0.93 }, ou: { line: 2.5, h: 0.93, a: 0.93 } })!;
    expect(ps.winnerName).toBe("");
    expect(ps.advice).toContain("暂无明确方向");
  });
});

describe("llmUsageWindow(usage 接口必须带日期窗口,缺参网关返回 0)", () => {
  it("窗口为过去 90 天到明天", () => {
    const now = Date.parse("2026-06-11T12:00:00Z");
    const w = llmUsageWindow(now);
    expect(w.start).toBe("2026-03-13");
    expect(w.end).toBe("2026-06-12");
  });
});
