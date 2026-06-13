import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import { fixtureById, upsertFixture } from "../../src/server/af/store";
import {
  fixtureDetailPartKey,
  fixtureDetailPartsForBundle,
  refreshFixtureDetailsFromAf,
} from "../../src/server/af/fixture-details";
import type { AfEnvelope } from "../../src/server/af/client";

function afFixture(id: number, kickoffUtc: number, status = "NS") {
  return {
    fixture: { id, date: new Date(kickoffUtc).toISOString(), status: { short: status, elapsed: null } },
    league: { id: 39, season: 2026, name: "Premier League", round: "Regular Season - 1" },
    teams: { home: { id: 50, name: "Home" }, away: { id: 42, name: "Away" } },
    goals: { home: null, away: null },
  };
}

beforeEach(() => {
  _resetDbForTest();
});

describe("fixture detail fetch planning", () => {
  it("赛前 60 分钟外不探测事件/统计/阵容详情", () => {
    const now = Date.parse("2026-06-12T10:00:00Z");
    const parts = fixtureDetailPartsForBundle({ kickoff_utc: now + 2 * 3_600_000, status: "NS" }, {}, { now, deep: true });
    expect(fixtureDetailPartKey(parts)).toBe("");
  });

  it("T-60 内只补缺失阵容,不把赛前空事件伪装成问题", () => {
    const now = Date.parse("2026-06-12T10:00:00Z");
    const parts = fixtureDetailPartsForBundle({ kickoff_utc: now + 45 * 60_000, status: "NS" }, {}, { now, deep: true });
    expect(parts).toEqual({ lineups: true });
  });

  it("开赛后按缺失块补抓赛况/统计,深度视图才补单场球员数据", () => {
    const now = Date.parse("2026-06-12T10:00:00Z");
    const shallow = fixtureDetailPartsForBundle(
      { kickoff_utc: now - 10 * 60_000, status: "1H" },
      { lineups: [{ team: { id: 50 } }] },
      { now },
    );
    expect(shallow).toEqual({ events: true, statistics: true });

    const deep = fixtureDetailPartsForBundle(
      { kickoff_utc: now - 10 * 60_000, status: "1H" },
      { lineups: [{ team: { id: 50 } }], events: [{}], statistics: [{}] },
      { now, deep: true },
    );
    expect(deep).toEqual({ players: true });
  });
});

describe("refreshFixtureDetailsFromAf", () => {
  it("只把 AF 非空详情数组合并进 fixture payload", async () => {
    upsertFixture(afFixture(900, Date.parse("2026-06-12T12:00:00Z"), "1H"));
    const calls: string[] = [];
    const fetcher = async (metric: string, path: string): Promise<AfEnvelope> => {
      calls.push(`${metric}:${path}`);
      if (metric === "fixtures.events") return { response: [{ type: "Goal", time: { elapsed: 12 } }] };
      if (metric === "fixtures.statistics") return { response: [] };
      return { response: null };
    };

    const patch = await refreshFixtureDetailsFromAf(
      900,
      { events: true, statistics: true, lineups: true },
      { fetcher, updatedAt: 123456 },
    );

    expect(calls).toEqual([
      "fixtures.events:/fixtures/events?fixture=900",
      "fixtures.statistics:/fixtures/statistics?fixture=900",
      "fixtures.lineups:/fixtures/lineups?fixture=900",
    ]);
    expect(patch).toEqual({ events: [{ type: "Goal", time: { elapsed: 12 } }] });
    const fx = fixtureById(900)!;
    expect(fx.updated_at).toBe(123456);
    expect(JSON.parse(fx.payload)).toMatchObject({ events: [{ type: "Goal" }] });
    expect(JSON.parse(fx.payload).statistics).toBeUndefined();
    expect(JSON.parse(fx.payload).lineups).toBeUndefined();
  });

  it("记录 AF 详情端点空返回/errors/请求失败,但不阻塞其它详情补抓", async () => {
    upsertFixture(afFixture(901, Date.parse("2026-06-12T12:00:00Z"), "1H"));
    const fetcher = async (metric: string): Promise<AfEnvelope> => {
      if (metric === "fixtures.events") return { response: [], results: 0, parameters: { fixture: "901" } };
      if (metric === "fixtures.statistics") return { response: [{ team: { id: 50 }, statistics: [] }], results: 1 };
      if (metric === "fixtures.lineups") return { response: [], errors: { fixture: "bad fixture" }, parameters: { fixture: "901" } };
      throw new Error("network down");
    };

    const patch = await refreshFixtureDetailsFromAf(
      901,
      { events: true, statistics: true, lineups: true, players: true },
      { fetcher },
    );

    expect(patch).toEqual({ statistics: [{ team: { id: 50 }, statistics: [] }] });
    const issues = db()
      .prepare("SELECT endpoint, error_type, severity FROM diagnostic_issues ORDER BY issue_id")
      .all() as { endpoint: string; error_type: string; severity: string }[];
    expect(issues).toEqual([
      { endpoint: "fixtures.events", error_type: "FIXTURE_DETAIL_EMPTY", severity: "info" },
      { endpoint: "fixtures.lineups", error_type: "FIXTURE_DETAIL_ERROR", severity: "error" },
      { endpoint: "fixtures.players", error_type: "FIXTURE_DETAIL_FETCH_ERROR", severity: "error" },
    ]);
    const raw = db()
      .prepare("SELECT endpoint, fixture_id FROM af_raw_payloads ORDER BY id")
      .all() as { endpoint: string; fixture_id: number }[];
    expect(raw).toEqual([
      { endpoint: "fixtures.statistics", fixture_id: 901 },
      { endpoint: "fixtures.lineups", fixture_id: 901 },
    ]);
  });
});
