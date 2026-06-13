import { describe, expect, it } from "vitest";

import { euRows, seriesRows } from "../../src/server/views/detail";
import type { SnapRow } from "../../src/server/af/store";

function snap(at: number, line: number | null, h: number, a: number, d: number | null = null): SnapRow {
  return {
    fixture_id: 1,
    bookmaker_id: 8,
    bookmaker: "Bet365",
    market: d == null ? "ah" : "eu",
    line,
    h,
    a,
    d,
    captured_at: at,
  };
}

describe("detail odds quote rows", () => {
  it("稳定未变盘的赛前序列展示最新三帧", () => {
    const rows = seriesRows([
      snap(Date.parse("2026-06-13T00:00:00Z"), 0.5, 0.9, 0.96),
      snap(Date.parse("2026-06-13T03:00:00Z"), 0.5, 0.88, 0.98),
      snap(Date.parse("2026-06-13T06:00:00Z"), 0.5, 0.87, 0.99),
      snap(Date.parse("2026-06-13T09:00:00Z"), 0.5, 0.86, 1.0),
    ], "ah", "UTC+0").rows;

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.t)).toEqual(["03:00", "06:00", "09:00"]);
    expect(rows.every((r) => !r.chg)).toBe(true);
  });

  it("变盘序列也展示最新三帧,变盘标记按完整上一帧计算", () => {
    const rows = seriesRows([
      snap(Date.parse("2026-06-13T00:00:00Z"), 0.5, 0.9, 0.96),
      snap(Date.parse("2026-06-13T03:00:00Z"), 0.75, 0.9, 0.96),
      snap(Date.parse("2026-06-13T06:00:00Z"), 1, 0.88, 0.98),
      snap(Date.parse("2026-06-13T09:00:00Z"), 1, 0.86, 1.0),
    ], "ah", "UTC+0").rows;

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.t)).toEqual(["03:00", "06:00", "09:00"]);
    expect(rows.map((r) => r.chg)).toEqual([true, true, false]);
  });

  it("胜平负也使用同一组最新三帧口径", () => {
    const rows = euRows([
      snap(Date.parse("2026-06-13T00:00:00Z"), null, 1.8, 4.5, 3.6),
      snap(Date.parse("2026-06-13T03:00:00Z"), null, 1.75, 4.7, 3.7),
      snap(Date.parse("2026-06-13T06:00:00Z"), null, 1.72, 4.8, 3.8),
      snap(Date.parse("2026-06-13T09:00:00Z"), null, 1.7, 4.9, 3.9),
    ], "UTC+0");

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.t)).toEqual(["03:00", "06:00", "09:00"]);
  });
});
