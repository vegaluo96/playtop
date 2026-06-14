/** 快照落库 + 异动 diff + 战绩结算(内存库,模拟 AF 信封) */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import {
  archiveOdds,
  archivePrediction,
  fixtureById,
  mainOddsSnapshot,
  mergeFixturePayload,
  modelStats,
  movementsOf,
  oddsBundle,
  oddsCompare,
  oddsSeries,
  oddsSeriesBatch,
  recentMovements,
  kvCached,
  latestPredictionsMap,
  latestPredictionBefore,
  oddsBundleBefore,
  settleFixture,
  upsertFixture,
} from "../../src/server/af/store";
import { diagnosticIssueSummary } from "../../src/server/af/diagnostics";

function afFixture(id: number, opts: { status?: string; gh?: number; ga?: number } = {}) {
  return {
    fixture: { id, date: "2026-06-11T19:00:00+00:00", status: { short: opts.status ?? "NS", elapsed: null }, venue: { id: 1, name: "X", city: "Y" } },
    league: { id: 39, season: 2025, name: "Premier League", round: "Regular Season - 30" },
    teams: { home: { id: 50, name: "曼城" }, away: { id: 42, name: "阿森纳" } },
    goals: { home: opts.gh ?? null, away: opts.ga ?? null },
  };
}

function odds(line: number, h: number, a: number) {
  return {
    bookmakers: [
      {
        id: 8,
        name: "Bet365",
        bets: [
          {
            id: 4,
            name: "Asian Handicap",
            values: [
              { value: `Home ${-line >= 0 ? "+" : ""}${-line}`, odd: String(1 + h) },
              { value: `Away ${line >= 0 ? "+" : ""}${line}`, odd: String(1 + a) },
            ],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  _resetDbForTest();
});

describe("fixtures_cache", () => {
  it("upsert 用最新基础赛程,但保留已有详情数组", () => {
    upsertFixture(afFixture(100));
    const fx = fixtureById(100)!;
    expect(fx).toMatchObject({ league_id: 39, home_name: "曼城", away_name: "阿森纳", status: "NS" });
    const long = { ...afFixture(100), events: [{ type: "Goal" }] };
    upsertFixture(long);
    const latest = afFixture(100, { status: "FT", gh: 2, ga: 1 });
    (latest.fixture.status as { elapsed: number | null }).elapsed = 90;
    upsertFixture(latest); // 较短的列表帧,但基础状态/比分更新

    const next = fixtureById(100)!;
    const payload = JSON.parse(next.payload);
    expect(next).toMatchObject({ status: "FT", elapsed: 90, goals_home: 2, goals_away: 1 });
    expect(payload.fixture.status.short).toBe("FT");
    expect(payload.goals.home).toBe(2);
    expect(payload.events).toEqual([{ type: "Goal" }]);
  });

  it("mergeFixturePayload 合并独立详情端点,不改基础赛程字段", () => {
    upsertFixture(afFixture(101));
    expect(mergeFixturePayload(101, {
      events: [{ type: "Goal" }],
      lineups: [{ team: { id: 50 }, coach: { name: "Coach A" } }],
      statistics: [{ team: { id: 50 }, statistics: [] }],
    }, 12345)).toBe(true);

    const fx = fixtureById(101)!;
    expect(fx.home_name).toBe("曼城");
    expect(fx.away_name).toBe("阿森纳");
    expect(fx.updated_at).toBe(12345);
    expect(JSON.parse(fx.payload)).toMatchObject({
      events: [{ type: "Goal" }],
      lineups: [{ team: { id: 50 }, coach: { name: "Coach A" } }],
      statistics: [{ team: { id: 50 }, statistics: [] }],
    });
  });
});

describe("kvCached", () => {
  it("空官方结果使用短 TTL,避免 AF 后续补齐后长时间仍显示暂无", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetcher = vi.fn(async () => {
        calls++;
        return calls === 1 ? [] : ["ready"];
      });

      vi.setSystemTime(new Date(1_000));
      await expect(kvCached("empty-af", 60_000, fetcher, { emptyTtlMs: 1_000 })).resolves.toEqual([]);
      vi.setSystemTime(new Date(1_500));
      await expect(kvCached("empty-af", 60_000, fetcher, { emptyTtlMs: 1_000 })).resolves.toEqual([]);
      vi.setSystemTime(new Date(2_100));
      await expect(kvCached("empty-af", 60_000, fetcher, { emptyTtlMs: 1_000 })).resolves.toEqual(["ready"]);

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("odds 归档与异动", () => {
  it("相邻快照 diff:升盘+水位变化生成 movements,序列与百家对比可查", () => {
    upsertFixture(afFixture(200));
    expect(archiveOdds(200, odds(1.25, 0.9, 0.96), 1000)).toBe(0); // 首帧无 diff
    expect(archiveOdds(200, odds(1.5, 0.85, 1.01), 2000)).toBe(1); // 升盘
    const moves = movementsOf(200);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "升盘", sev: 1, bookmaker: "Bet365" });
    expect(oddsSeries(200, "ah")).toHaveLength(2);
    const cmp = oddsCompare(200, "ah");
    expect(cmp[0].first.line).toBe(1.25);
    expect(cmp[0].last.line).toBe(1.5);
  });

  it("数值未变的快照短期内不重复落库", () => {
    upsertFixture(afFixture(201));
    archiveOdds(201, odds(1, 0.9, 0.96), 1000);
    archiveOdds(201, odds(1, 0.9, 0.96), 2000);
    expect(oddsSeries(201, "ah")).toHaveLength(1);
  });

  it("归一化暂未识别市场时仍保留 odds_raw,方便重放修复", () => {
    upsertFixture(afFixture(203));
    expect(archiveOdds(203, { fixture: { id: 203 }, bookmakers: [{ id: 8, name: "Bet365", bets: [] }] }, 3000)).toBe(0);
    const raw = db().prepare("SELECT fixture_id, captured_at, payload FROM odds_raw WHERE fixture_id=?").get(203) as
      | { fixture_id: number; captured_at: number; payload: string }
      | undefined;
    expect(raw).toMatchObject({ fixture_id: 203, captured_at: 3000 });
    expect(JSON.parse(raw!.payload)).toMatchObject({ bookmakers: [{ id: 8, name: "Bet365" }] });
    expect(oddsSeries(203, "ah")).toEqual([]);
    const envelope = db().prepare("SELECT endpoint, request_params, fixture_id, parser_version, payload FROM af_raw_payloads WHERE fixture_id=?").get(203) as
      | { endpoint: string; request_params: string; fixture_id: number; parser_version: string; payload: string }
      | undefined;
    expect(envelope).toMatchObject({ endpoint: "odds", fixture_id: 203 });
    expect(JSON.parse(envelope!.request_params)).toEqual({ fixture: 203 });
    expect(envelope!.parser_version).toContain("odds-adapter");
    expect(JSON.parse(envelope!.payload)).toMatchObject({ fixture: { id: 203 } });
  });

  it("odds fixture_id 串场时只保留 raw 和诊断,不进入标准盘口", () => {
    upsertFixture(afFixture(211));
    expect(archiveOdds(211, { fixture: { id: 999 }, bookmakers: [{ id: 8, name: "Bet365", bets: [
      { id: 5, name: "Goals Over/Under", values: [
        { value: "Over 2.5", odd: "1.90" }, { value: "Under 2.5", odd: "1.96" },
      ] },
    ] }] }, 4000)).toBe(0);

    expect(oddsSeries(211, "ou")).toEqual([]);
    const issue = db().prepare("SELECT error_type, severity FROM diagnostic_issues WHERE fixture_id=?").get(211) as
      | { error_type: string; severity: string }
      | undefined;
    expect(issue).toMatchObject({ error_type: "FIXTURE_MISMATCH", severity: "error" });
    const raw = db().prepare("SELECT endpoint FROM af_raw_payloads WHERE fixture_id=?").get(211) as { endpoint: string } | undefined;
    expect(raw?.endpoint).toBe("odds");
  });

  it("归一化拒收的盘口写入 DiagnosticIssue", () => {
    upsertFixture(afFixture(208));
    archiveOdds(208, {
      fixture: { id: 208 },
      bookmakers: [{ id: 8, name: "Bet365", bets: [
        { id: 1, name: "Match Winner", values: [
          { value: "Home", odd: "51" }, { value: "Draw", odd: "5" }, { value: "Away", odd: "1.14" },
        ] },
        { id: 4, name: "Asian Handicap", values: [
          { value: "Home -0.3", odd: "1.90" }, { value: "Away +0.3", odd: "1.96" },
        ] },
      ] }],
    }, 3000);

    const issues = db().prepare("SELECT endpoint, fixture_id, bookmaker_id, bet_id, error_type FROM diagnostic_issues WHERE fixture_id=? ORDER BY issue_id").all(208) as
      { endpoint: string; fixture_id: number; bookmaker_id: number; bet_id: number; error_type: string }[];
    expect(issues.some((i) => i.endpoint === "odds" && i.bet_id === 1 && i.error_type === "ODDS_OUT_OF_RANGE")).toBe(true);
    expect(issues.some((i) => i.endpoint === "odds" && i.bet_id === 4 && i.error_type === "LINE_INVALID")).toBe(true);
    const summary = diagnosticIssueSummary(Date.now() - 60_000);
    expect(summary.total).toBeGreaterThanOrEqual(2);
    expect(summary.byType.some((i) => i.error_type === "ODDS_OUT_OF_RANGE")).toBe(true);
    expect(summary.byFixture.some((i) => i.fixture_id === 208)).toBe(true);
  });

  it("主盘按共识盘口+主流书商优先,不被最新离群书商带偏", () => {
    upsertFixture(afFixture(202));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(202, 8, "Bet365", "ou", 2.25, 0.9, 0.95, null, 1000);
    ins.run(202, 4, "平博", "ou", 2.25, 0.92, 0.93, null, 1100);
    ins.run(202, 99, "10Bet", "ou", 2.5, 0.88, 0.9, null, 5000);
    // 共识线 2.25(2 家 > 1 家),水位取该线各家中位(0.9/0.92→0.91,0.95/0.93→0.94),不被 10Bet 的离群 2.5 带偏
    expect(mainOddsSnapshot(202, "ou")).toMatchObject({ bookmaker: "主流共识", line: 2.25, h: 0.91, a: 0.94 });
    expect(oddsSeries(202, "ou").at(-1)).toMatchObject({ bookmaker: "主流共识", line: 2.25, h: 0.91, a: 0.94 });
  });

  it("主盘选择先看盘口线覆盖数,覆盖数明显领先时不被少数主流书商带偏", () => {
    upsertFixture(afFixture(209));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ["小1", "小2", "小3", "小4", "小5", "小6", "小7", "小8", "小9", "小10", "小11", "小12", "小13", "小14"].forEach((book, i) => {
      ins.run(209, 100 + i, book, "ah", 0.5, 0.9 + (i % 3) * 0.01, 0.96, null, 1000 + i);
    });
    ["Bet365", "平博", "马拉松", "Bwin", "1xBet"].forEach((book, i) => {
      ins.run(209, 8 + i, book, "ah", 0.25, 0.88, 0.98, null, 5000 + i);
    });

    expect(mainOddsSnapshot(209, "ah")).toMatchObject({ line: 0.5 });
  });

  it("覆盖数较多的盘口线为共识线(中位),不被少数主流书商带偏", () => {
    upsertFixture(afFixture(210));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ["小1", "小2", "小3", "小4", "小5", "小6", "小7", "小8", "小9", "小10"].forEach((book, i) => {
      ins.run(210, 200 + i, book, "ou", 2.25, 0.92, 0.94, null, 1000 + i);
    });
    ["Bet365", "平博", "马拉松", "Bwin", "1xBet", "必发", "WilliamHill", "Unibet"].forEach((book, i) => {
      ins.run(210, 300 + i, book, "ou", 2.5, 0.9, 0.95, null, 2000 + i);
    });

    // 10 家 2.25 vs 8 家 2.5 → 多数共识线 2.25;水位取该线各家中位 0.92/0.94
    expect(mainOddsSnapshot(210, "ou")).toMatchObject({ bookmaker: "主流共识", line: 2.25, h: 0.92, a: 0.94 });
  });

  it("低质量非主流单源盘口不进入用户端主盘序列", () => {
    upsertFixture(afFixture(212));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(212, 99, "SmallBook", "ah", 0.5, 0.9, 0.96, null, 1000);

    expect(oddsSeries(212, "ah")).toEqual([]);
  });

  it("oddsBundle 与单市场走势/百家对比口径一致", () => {
    upsertFixture(afFixture(204));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(204, 8, "Bet365", "ah", 0.5, 0.9, 0.96, null, 1000);
    ins.run(204, 8, "Bet365", "ah", 0.5, 0.88, 0.98, null, 2000);
    ins.run(204, 4, "平博", "ah", 0.5, 0.91, 0.95, null, 2100);
    ins.run(204, 99, "10Bet", "ah", 0.75, 0.86, 1.0, null, 5000);
    ins.run(204, 8, "Bet365", "eu", null, 1.6, 3.8, 5.2, 1000);
    ins.run(204, 8, "Bet365", "eu", null, 1.55, 3.9, 5.4, 2000);
    ins.run(204, 4, "平博", "eu", null, 1.58, 3.85, 5.1, 2100);

    const bundle = oddsBundle(204);

    expect(bundle.ah).toEqual(oddsSeries(204, "ah"));
    expect(bundle.eu).toEqual(oddsSeries(204, "eu"));
    expect(bundle.compareAh).toEqual(oddsCompare(204, "ah"));
    expect(bundle.compareEu).toEqual(oddsCompare(204, "eu"));
  });

  it("oddsSeriesBatch 与 oddsSeries 单场口径一致", () => {
    upsertFixture(afFixture(205));
    upsertFixture(afFixture(206));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(205, 8, "Bet365", "ah", 0.25, 0.92, 0.94, null, 1000);
    ins.run(205, 8, "Bet365", "ah", 0.5, 0.88, 1.0, null, 2000);
    ins.run(205, 4, "平博", "ah", 0.5, 0.9, 0.98, null, 2100);
    ins.run(206, 99, "10Bet", "ah", 1, 0.86, 1.02, null, 1000);
    ins.run(206, 4, "平博", "ah", 0.75, 0.91, 0.95, null, 1500);
    ins.run(206, 8, "Bet365", "ah", 0.75, 0.89, 0.97, null, 1600);

    const batch = oddsSeriesBatch([205, 206], "ah");

    expect(batch.get(205)).toEqual(oddsSeries(205, "ah"));
    expect(batch.get(206)).toEqual(oddsSeries(206, "ah"));
  });

  it("用户端异动流过滤滚球胜平负极端脏帧", () => {
    upsertFixture(afFixture(207, { status: "2H", gh: 0, ga: 1 }));
    const ins = db().prepare(
      "INSERT INTO movements (fixture_id, market, bookmaker, type, from_line, to_line, from_h, to_h, from_a, to_a, sev, t0, t1, phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run(207, "eu", "实时盘", "水位", null, null, 101, 251, 1.1, 1.05, 1, 1000, 2000, "滚球");
    ins.run(207, "ah", "实时盘", "升盘", 0.25, 0.5, 0.9, 0.86, 0.96, 1, 1, 3000, 4000, "滚球");

    const rows = recentMovements(10);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market: "ah", type: "升盘" });
  });
});

describe("模型战绩结算", () => {
  it("FT 后按预测 winner 对照比分;统计聚合正确", () => {
    upsertFixture(afFixture(300, { status: "FT", gh: 2, ga: 1 }));
    archivePrediction(300, {
      predictions: { winner: { id: 50, name: "曼城" }, win_or_draw: false, percent: { home: "58%", draw: "22%", away: "20%" } },
    }, Date.parse("2026-06-11T18:00:00Z"));
    settleFixture(fixtureById(300)!);
    const s = modelStats(Date.parse("2026-06-12T04:00:00Z"));
    expect(s.hitRate30).toBe(100);
    expect(s.yesterdayRows.length + s.week.reduce((n, w) => n + w.total, 0)).toBeGreaterThan(0);
  });

  it("回测只使用开赛前最后一版预测和指数,赛后快照不污染结算", () => {
    upsertFixture(afFixture(310, { status: "FT", gh: 1, ga: 2 }));
    const ins = db().prepare(
      "INSERT INTO odds_snapshots (fixture_id, bookmaker_id, bookmaker, market, line, h, a, d, captured_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ins.run(310, 8, "Bet365", "ah", -0.5, 0.9, 0.96, null, Date.parse("2026-06-11T18:30:00Z"));
    ins.run(310, 8, "Bet365", "ou", 2.5, 1.02, 0.82, null, Date.parse("2026-06-11T18:30:00Z"));
    ins.run(310, 8, "Bet365", "ah", 1.5, 0.75, 1.1, null, Date.parse("2026-06-11T20:00:00Z"));
    archivePrediction(310, {
      predictions: { winner: { id: 42, name: "阿森纳" }, win_or_draw: false, under_over: "-2.5", percent: { home: "20%", draw: "25%", away: "55%" } },
    }, Date.parse("2026-06-11T18:50:00Z"));
    archivePrediction(310, {
      predictions: { winner: { id: 50, name: "曼城" }, win_or_draw: false, under_over: "+3.5", percent: { home: "80%", draw: "10%", away: "10%" } },
    }, Date.parse("2026-06-11T20:10:00Z"));

    expect(latestPredictionBefore(310, Date.parse("2026-06-11T18:59:59Z"))).toMatchObject({ predictions: { winner: { id: 42 } } });
    expect(oddsBundleBefore(310, Date.parse("2026-06-11T18:59:59Z")).ah.at(-1)?.line).toBe(-0.5);

    settleFixture(fixtureById(310)!);

    const row = db().prepare("SELECT pick, hit, ah_pick, ah_hit, ou_pick, ou_hit FROM model_records WHERE fixture_id = 310").get() as
      | { pick: string; hit: number; ah_pick: string | null; ah_hit: number | null; ou_pick: string | null; ou_hit: number | null }
      | undefined;
    expect(row).toMatchObject({ pick: "阿森纳胜", hit: 1, ah_hit: 1, ou_hit: 0 });
    expect(row?.ah_pick).toContain("阿森纳");
    expect(row?.ou_pick).toContain("小于");
  });

  it("modelStats 用同一 30 日窗口聚合命中率/昨日/周趋势/连中", () => {
    const ins = db().prepare(
      "INSERT INTO model_records (fixture_id, date, match_name, pick, score, hit, settled_at) VALUES (?,?,?,?,?,?,?)",
    );
    ins.run(401, "2026-06-10", "A vs B", "A 胜", "0-1", 0, 1000);
    ins.run(402, "2026-06-11", "C vs D", "C 胜", "2-0", 1, 2000);
    ins.run(403, "2026-06-11", "E vs F", "F 胜", "1-1", 0, 3000);
    ins.run(404, "2026-06-12", "G vs H", "G 胜", "3-1", 1, 4000);

    const s = modelStats(Date.parse("2026-06-12T04:00:00Z"));

    expect(s.hitRate30).toBe(50);
    expect(s.yesterday).toEqual({ hit: 1, total: 2 });
    expect(s.yesterdayRows.map((r) => r.match)).toEqual(["C vs D", "E vs F"]);
    expect(s.week.find((r) => r.date === "2026-06-10")).toEqual({ date: "2026-06-10", hit: 0, total: 1 });
    expect(s.week.find((r) => r.date === "2026-06-11")).toEqual({ date: "2026-06-11", hit: 1, total: 2 });
    expect(s.week.find((r) => r.date === "2026-06-12")).toEqual({ date: "2026-06-12", hit: 1, total: 1 });
    expect(s.streak).toBe(1);
  });

  it("无预测快照的完场不结算", () => {
    upsertFixture(afFixture(301, { status: "FT", gh: 0, ga: 0 }));
    settleFixture(fixtureById(301)!);
    expect(modelStats().hitRate30).toBeNull();
  });

  it("latestPredictionsMap 批量返回每场最新预测快照", () => {
    upsertFixture(afFixture(302));
    upsertFixture(afFixture(303));
    archivePrediction(302, { predictions: { percent: { home: "40%", draw: "30%", away: "30%" } } }, 1000);
    archivePrediction(302, { predictions: { percent: { home: "55%", draw: "25%", away: "20%" } } }, 2000);
    archivePrediction(303, { predictions: { percent: { home: "20%", draw: "35%", away: "45%" } } }, 1500);

    const map = latestPredictionsMap([302, 303, 304]);

    expect(map.get(302)).toMatchObject({ predictions: { percent: { home: "55%" } } });
    expect(map.get(303)).toMatchObject({ predictions: { percent: { away: "45%" } } });
    expect(map.has(304)).toBe(false);
  });
});
