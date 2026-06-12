/** 外部盘口校准:样本导入 / 时间对齐 / 线差与水位差判定 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import { compareExternalOdds, importExternalOddsSamples, localMainSnapshotAt, normalizeExternalOddsInput } from "../../src/server/af/calibrate";

beforeEach(() => {
  _resetDbForTest();
});

function snap(fixtureId: number, bookmaker: string, line: number, h: number, a: number, at: number) {
  db().prepare(
    "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(fixtureId, bookmaker === "Bet365" ? 8 : 99, bookmaker, "ah", line, h, a, null, at);
}

describe("normalizeExternalOddsInput", () => {
  it("ah/ou decimal 输入自动转净水", () => {
    const s = normalizeExternalOddsInput({ fixtureId: 1, source: "外部", market: "ah", line: 0.25, h: 1.9, a: 1.96, format: "decimal" });
    expect(s.h).toBe(0.9);
    expect(s.a).toBe(0.96);
  });
});

describe("compareExternalOdds", () => {
  it("按样本时间取本地主流共识盘;同线小水差为 ok", () => {
    snap(100, "Bet365", 0.25, 0.9, 0.96, 1000);
    snap(100, "杂牌", 0.5, 0.88, 0.91, 2000);
    const samples = importExternalOddsSamples([{ fixtureId: 100, source: "足球财富", market: "ah", line: 0.25, h: 0.91, a: 0.94, capturedAt: 1200 }]);
    const rows = compareExternalOdds(samples, { skewMs: 1000, waterTolerance: 0.05 });
    expect(rows[0].status).toBe("ok");
    expect(rows[0].local?.bookmaker).toBe("Bet365");
  });

  it("同线水位差过大为 warn;盘口线不同为 fail", () => {
    snap(101, "Bet365", 0.25, 0.9, 0.96, 1000);
    const warn = compareExternalOdds(importExternalOddsSamples([{ fixtureId: 101, source: "百度", market: "ah", line: 0.25, h: 0.7, a: 1.15, capturedAt: 1000 }]));
    expect(warn[0].status).toBe("warn");
    const fail = compareExternalOdds(importExternalOddsSamples([{ fixtureId: 101, source: "百度", market: "ah", line: 0.5, h: 0.9, a: 0.96, capturedAt: 1000 }]));
    expect(fail[0].status).toBe("fail");
  });

  it("无本地快照为 missing", () => {
    const rows = compareExternalOdds(importExternalOddsSamples([{ fixtureId: 999, source: "外部", market: "ah", line: 0.25, h: 0.9, a: 0.96 }]));
    expect(rows[0].status).toBe("missing");
  });

  it("localMainSnapshotAt 无样本前快照时返回 null", () => {
    snap(102, "Bet365", 0.25, 0.9, 0.96, 5000);
    expect(localMainSnapshotAt(102, "ah", 1000, 500)).toBeNull();
  });
});
