/** 滚球归档:仅变化帧落库 + 心跳帧;封盘帧跳过异动;60s 冷却;滚球 phase */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { db, _resetDbForTest } from "../../src/server/db";
import { archiveLiveOdds, liveOddsSeries, liveOddsSeriesByMarket, pruneLiveData } from "../../src/server/af/live-store";
import { normalizeLiveOddsItem, type LiveMarketFrame } from "../../src/server/af/normalize";

const ah = (line: number, h: number, a: number, suspended = false): LiveMarketFrame => ({ market: "ah", line, h, a, d: null, suspended });

beforeEach(() => {
  _resetDbForTest();
  db();
});

describe("archiveLiveOdds", () => {
  it("仅变化帧落库:相同帧 5 分钟内不重复写", () => {
    const t = 1_000_000;
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], t);
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], t + 5_000); // 无变化 → 跳过
    archiveLiveOdds(9, [ah(0.5, 0.92, 0.94)], t + 10_000); // 水位变了 → 写
    expect(liveOddsSeries(9, "ah")).toHaveLength(2);
  });

  it("无变化超过 5 分钟写心跳帧(证明数据仍在盯)", () => {
    const t = 1_000_000;
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], t);
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], t + 5 * 60_000 + 1);
    expect(liveOddsSeries(9, "ah")).toHaveLength(2);
  });

  it("变化帧产生滚球异动(phase=滚球);封盘帧不判异动", () => {
    const t = 1_000_000;
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], t);
    const n = archiveLiveOdds(9, [ah(0.75, 0.85, 1.01)], t + 90_000); // 升盘
    expect(n).toBe(1);
    const mv = db().prepare("SELECT * FROM movements WHERE fixture_id=9").all() as { phase: string; type: string }[];
    expect(mv).toHaveLength(1);
    expect(mv[0].phase).toBe("滚球");
    expect(mv[0].type).toBe("升盘");
    // 封盘帧:落库但不出异动
    const n2 = archiveLiveOdds(9, [ah(1, 0.8, 1.06, true)], t + 200_000);
    expect(n2).toBe(0);
  });

  it("同市场 60s 冷却:进球瞬间盘口翻飞不刷屏", () => {
    const t = 1_000_000;
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], t);
    expect(archiveLiveOdds(9, [ah(0.75, 0.85, 1.01)], t + 30_000)).toBe(1);
    expect(archiveLiveOdds(9, [ah(1, 0.8, 1.06)], t + 60_000)).toBe(0); // 距上条异动 30s → 冷却
    expect(archiveLiveOdds(9, [ah(1.25, 0.78, 1.08)], t + 200_000)).toBe(1); // 冷却结束
  });

  it("eu 帧:主胜赔 |Δ|≥0.10 记水位异动", () => {
    const t = 1_000_000;
    const eu = (h: number, d: number, a: number): LiveMarketFrame => ({ market: "eu", line: null, h, a, d, suspended: false });
    archiveLiveOdds(9, [eu(1.5, 4.2, 6.0)], t);
    expect(archiveLiveOdds(9, [eu(1.52, 4.2, 6.0)], t + 90_000)).toBe(0); // 0.02 不记
    expect(archiveLiveOdds(9, [eu(1.8, 3.6, 4.5)], t + 200_000)).toBe(1);
  });

  it("liveOddsSeriesByMarket 一次性按市场返回滚球帧", () => {
    const t = 1_000_000;
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96), { market: "ou", line: 2.5, h: 0.88, a: 0.98, d: null, suspended: false }], t);
    archiveLiveOdds(9, [{ market: "eu", line: null, h: 1.8, d: 3.5, a: 4.2, suspended: false }], t + 90_000);

    const rows = liveOddsSeriesByMarket(9);

    expect(rows.ah).toHaveLength(1);
    expect(rows.ou).toHaveLength(1);
    expect(rows.eu).toHaveLength(1);
    expect(rows.ah[0]).toMatchObject({ line: 0.5, h: 0.9 });
  });

  it("pruneLiveData 清理完场 7 天以上的滚球帧", () => {
    const now = Date.now();
    db().prepare(
      "INSERT INTO fixtures_cache (fixture_id, league_id, season, kickoff_utc, status, updated_at) VALUES (9, 39, 2026, ?, 'FT', ?)",
    ).run(now - 10 * 86_400_000, now);
    archiveLiveOdds(9, [ah(0.5, 0.9, 0.96)], now - 10 * 86_400_000);
    const r = pruneLiveData(now);
    expect(r.liveRows).toBe(1);
    expect(liveOddsSeries(9, "ah")).toHaveLength(0);
  });
});

describe("normalizeLiveOddsItem", () => {
  it("解析 AF /odds/live:主盘优先、净水换算、handicap 取反、封盘标记", () => {
    const item = {
      fixture: { id: 9 },
      odds: [
        {
          name: "Asian Handicap",
          values: [
            { value: "Home", handicap: "-0.5", odd: "1.90", main: true, suspended: false },
            { value: "Away", handicap: "0.5", odd: "1.98", main: true, suspended: false },
            { value: "Home", handicap: "-1.5", odd: "2.80", main: false, suspended: false },
          ],
        },
        {
          name: "Over/Under Line",
          values: [
            { value: "Over", handicap: "2.5", odd: "1.85", main: true, suspended: true },
            { value: "Under", handicap: "2.5", odd: "2.01", main: true, suspended: false },
          ],
        },
        {
          name: "Fulltime Result",
          values: [
            { value: "Home", odd: "1.45" }, { value: "Draw", odd: "4.50" }, { value: "Away", odd: "7.00" },
          ],
        },
      ],
    };
    const frames = normalizeLiveOddsItem(item);
    const ahF = frames.find((f) => f.market === "ah")!;
    expect(ahF.line).toBe(0.5); // handicap -0.5 → 主让半球
    expect(ahF.h).toBeCloseTo(0.9, 2);
    expect(ahF.suspended).toBe(false);
    const ouF = frames.find((f) => f.market === "ou")!;
    expect(ouF.line).toBe(2.5);
    expect(ouF.suspended).toBe(true); // 任一腿封盘即封盘
    const euF = frames.find((f) => f.market === "eu")!;
    expect(euF.h).toBe(1.45);
    expect(euF.d).toBe(4.5);
  });

  it("多线无 main:不取首条边缘线,按满水率+均衡挑真实主盘(大小球不对的根因)", () => {
    const item = {
      odds: [
        {
          name: "Over/Under Line",
          values: [
            // AF 返回顺序:低线在前——旧逻辑会错取 0.5 球
            { value: "Over", handicap: "0.5", odd: "1.05" }, { value: "Under", handicap: "0.5", odd: "8.50" },
            { value: "Over", handicap: "1.5", odd: "1.30" }, { value: "Under", handicap: "1.5", odd: "3.40" },
            { value: "Over", handicap: "2.5", odd: "1.90" }, { value: "Under", handicap: "2.5", odd: "1.92" },
            { value: "Over", handicap: "3.5", odd: "3.10" }, { value: "Under", handicap: "3.5", odd: "1.35" },
          ],
        },
        {
          name: "Asian Handicap",
          values: [
            { value: "Home", handicap: "-2.5", odd: "4.80" }, { value: "Away", handicap: "2.5", odd: "1.16" },
            { value: "Home", handicap: "-0.5", odd: "1.88" }, { value: "Away", handicap: "0.5", odd: "1.94" },
            { value: "Home", handicap: "-1.5", odd: "2.90" }, { value: "Away", handicap: "1.5", odd: "1.40" },
          ],
        },
      ],
    };
    const frames = normalizeLiveOddsItem(item);
    const ouF = frames.find((f) => f.market === "ou")!;
    expect(ouF.line).toBe(2.5); // 最均衡 = 真实主盘,而非首条 0.5
    expect(ouF.h).toBeCloseTo(0.9, 2);
    const ahF = frames.find((f) => f.market === "ah")!;
    expect(ahF.line).toBe(0.5); // Home -0.5 为主盘 → 主让半球
    expect(ahF.h).toBeCloseTo(0.88, 2);
    expect(ahF.a).toBeCloseTo(0.94, 2); // 两腿必须同线,不得错配 0.5/1.5
  });

  it("main 标志只是加分项:明显更均衡的非 main 主线可胜出", () => {
    const item = {
      odds: [{
        name: "Over/Under Line",
        values: [
          { value: "Over", handicap: "2.5", odd: "1.90", main: false }, { value: "Under", handicap: "2.5", odd: "1.92", main: false },
          { value: "Over", handicap: "3", odd: "2.05", main: true }, { value: "Under", handicap: "3", odd: "1.78", main: true },
        ],
      }],
    };
    const ouF = normalizeLiveOddsItem(item).find((f) => f.market === "ou")!;
    expect(ouF.line).toBe(2.5);
  });

  it("main 标志在主线质量接近时作为加分项", () => {
    const item = {
      odds: [{
        name: "Over/Under Line",
        values: [
          { value: "Over", handicap: "2.5", odd: "1.90", main: false }, { value: "Under", handicap: "2.5", odd: "1.98", main: false },
          { value: "Over", handicap: "3", odd: "1.90", main: true }, { value: "Under", handicap: "3", odd: "2.00", main: true },
        ],
      }],
    };
    const ouF = normalizeLiveOddsItem(item).find((f) => f.market === "ou")!;
    expect(ouF.line).toBe(3);
  });

  it("滚球胜平负只接收全场 FT market,不把分钟段 1x2 当成主欧盘", () => {
    const item = {
      odds: [
        {
          name: "1x2 - 80 minutes",
          values: [
            { value: "Home", odd: "41" }, { value: "Draw", odd: "4.33" }, { value: "Away", odd: "1.20" },
          ],
        },
        {
          name: "Fulltime Result",
          values: [
            { value: "Home", odd: "6.50" }, { value: "Draw", odd: "3.00" }, { value: "Away", odd: "1.73" },
          ],
        },
      ],
    };

    const euF = normalizeLiveOddsItem(item).find((f) => f.market === "eu")!;

    expect(euF.h).toBe(6.5);
    expect(euF.d).toBe(3);
    expect(euF.a).toBe(1.73);
  });

  it("滚球胜平负缺少 FT market 或出现极端赔率时不进入结构化主盘", () => {
    expect(
      normalizeLiveOddsItem({
        odds: [{ name: "1x2 - 80 minutes", values: [
          { value: "Home", odd: "41" }, { value: "Draw", odd: "4.33" }, { value: "Away", odd: "1.20" },
        ] }],
      }).some((f) => f.market === "eu"),
    ).toBe(false);
    expect(
      normalizeLiveOddsItem({
        odds: [{ name: "Fulltime Result", values: [
          { value: "Home", odd: "251" }, { value: "Draw", odd: "9.5" }, { value: "Away", odd: "1.05" },
        ] }],
      }).some((f) => f.market === "eu"),
    ).toBe(false);
  });

  it("滚球胜平负超过展示阈值时整组拒收,避免可疑 15/1.04/29 进入 summary", () => {
    const frames = normalizeLiveOddsItem({
      odds: [{ name: "Fulltime Result", values: [
        { value: "Home", odd: "15" }, { value: "Draw", odd: "1.04" }, { value: "Away", odd: "29" },
      ] }],
    });

    expect(frames.some((f) => f.market === "eu")).toBe(false);
  });

  it("滚球 parser 输出 DiagnosticIssue 草稿", () => {
    const issues: unknown[] = [];
    const frames = normalizeLiveOddsItem({
      odds: [
        { id: 99, name: "1x2 - 80 minutes", values: [
          { value: "Home", odd: "41" }, { value: "Draw", odd: "4.33" }, { value: "Away", odd: "1.20" },
        ] },
        { id: 100, name: "Fulltime Result", values: [
          { value: "Home", odd: "251" }, { value: "Draw", odd: "9.5" }, { value: "Away", odd: "1.05" },
        ] },
      ],
    }, { fixtureId: 9, onIssue: (i) => issues.push(i) });

    expect(frames.some((f) => f.market === "eu")).toBe(false);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: "odds.live", fixtureId: 9, betId: 99, errorType: "PERIOD_NOT_FT" }),
      expect.objectContaining({ endpoint: "odds.live", fixtureId: 9, betId: 100, errorType: "ODDS_OUT_OF_RANGE" }),
    ]));
  });

  it("坏数据安全返回空", () => {
    expect(normalizeLiveOddsItem({})).toEqual([]);
    expect(normalizeLiveOddsItem(null)).toEqual([]);
  });
});
