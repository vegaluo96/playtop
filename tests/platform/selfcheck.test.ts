/** 平台闭环体检:只读层判定 / 汇总链 / 测试数据清理彻底性(内存库) */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest, db } from "../../src/server/db";
import { checkReadonly, cleanupSelfcheckData, summarize, formatReport } from "../../src/server/selfcheck";
import { archiveOdds, archivePrediction, kvSet, setDailyFree, upsertFixture } from "../../src/server/af/store";
import { loginOrRegister } from "../../src/server/platform/auth";
import { claimGift, recharge } from "../../src/server/platform/wallet";

const TZ8 = 8 * 3_600_000;
const FIXED_NOW = Date.parse("2026-06-12T04:00:00Z");
const today8 = (now = Date.now()) => new Date(now + TZ8).toISOString().slice(0, 10);

function seedHealthy(now = FIXED_NOW) {
  const d = db();
  process.env.API_FOOTBALL_KEY = "test-key-selfcheck";
  d.prepare("INSERT OR REPLACE INTO admins (email, role, status, created_at) VALUES ('boss@x.com','超级管理员','启用',?)").run(now);
  kvSet("worker_heartbeat", String(now));
  upsertFixture({
    fixture: { id: 7001, date: new Date(now + 2 * 3_600_000).toISOString(), status: { short: "NS", elapsed: null } },
    league: { id: 39, season: 2025, name: "PL", round: "Regular Season - 1" },
    teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } },
    goals: { home: null, away: null },
  });
  const odds = (line: number) => ({
    bookmakers: [{ id: 8, name: "Bet365", bets: [{ id: 4, name: "Asian Handicap", values: [
      { value: `Home ${-line}`, odd: "1.90" }, { value: `Away ${line}`, odd: "1.96" },
    ] }] }],
  });
  archiveOdds(7001, odds(0.25), now - 60_000);
  archiveOdds(7001, odds(0.5), now - 30_000); // 真实变盘 → 必须有 movement
  archivePrediction(7001, { predictions: { winner: { id: 1, name: "A" }, percent: { home: "50%", draw: "25%", away: "25%" } } });
  setDailyFree(today8(now), 7001);
}

beforeEach(() => {
  _resetDbForTest();
});

describe("checkReadonly(只读层判定)", () => {
  it("健康库:除出网项外全部 ✓,无 fail", async () => {
    seedHealthy(FIXED_NOW);
    const rows = await checkReadonly({ skipNetwork: true, now: FIXED_NOW });
    const fails = rows.filter((r) => r.status === "fail");
    expect(fails).toEqual([]);
    expect(rows.find((r) => r.key === "异动生成")?.status).toBe("ok"); // 有真实变盘 → 必须查到 movement
  });

  it("worker 心跳超时 → 如实 ✗ 并给修复提示", async () => {
    seedHealthy(FIXED_NOW);
    kvSet("worker_heartbeat", String(FIXED_NOW - 10 * 60_000));
    const rows = await checkReadonly({ skipNetwork: true, now: FIXED_NOW });
    const beat = rows.find((r) => r.key === "worker 心跳 <3min")!;
    expect(beat.status).toBe("fail");
    expect(beat.note).toContain("前");
  });

  it("空库:赛况依赖项 skip(不伪造),环境缺失项 fail", async () => {
    delete process.env.API_FOOTBALL_KEY;
    const rows = await checkReadonly({ skipNetwork: true });
    expect(rows.find((r) => r.key === "AF 密钥已配置")?.status).toBe("fail");
    expect(rows.find((r) => r.key === "异动生成")?.status).toBe("skip");
    expect(rows.find((r) => r.key === "战绩结算")?.status).toBe("skip");
    expect(rows.find((r) => r.key === "指数快照新鲜度")?.status).toBe("skip"); // 无在售场次
  });

  it("完场概率信封缺 winner.id 时,战绩结算 skip 而非误报 fail", async () => {
    process.env.API_FOOTBALL_KEY = "test-key-selfcheck";
    upsertFixture({
      fixture: { id: 7101, date: new Date(Date.now() - 2 * 3_600_000).toISOString(), status: { short: "FT", elapsed: 90 } },
      league: { id: 39, season: 2025, name: "PL", round: "Regular Season - 1" },
      teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } },
      goals: { home: 1, away: 1 },
    });
    archivePrediction(7101, { predictions: { percent: { home: "34%", draw: "33%", away: "33%" } } });
    const rows = await checkReadonly({ skipNetwork: true });
    const settle = rows.find((r) => r.key === "战绩结算")!;
    expect(settle.status).toBe("skip");
    expect(settle.note).toContain("winner");
  });

  it("有变盘却无 movement → 异动生成 ✗(衍生链路断裂可被发现)", async () => {
    seedHealthy(FIXED_NOW);
    db().prepare("DELETE FROM movements").run();
    const rows = await checkReadonly({ skipNetwork: true, now: FIXED_NOW });
    expect(rows.find((r) => r.key === "异动生成")?.status).toBe("fail");
  });
});

describe("summarize / formatReport", () => {
  it("任一 fail 使该层标 ✗;闭环行可读", async () => {
    seedHealthy(FIXED_NOW);
    kvSet("worker_heartbeat", "0");
    const rep = summarize(await checkReadonly({ skipNetwork: true, now: FIXED_NOW }));
    expect(rep.summary.fail).toBeGreaterThan(0);
    expect(rep.chain).toContain("抓取 ✗");
    expect(formatReport(rep)).toContain("合计:");
  });
});

describe("cleanupSelfcheckData(测试数据零残留)", () => {
  it("删除 @check.internal 账号的全部账务痕迹与 SELFCHK 兑换码", () => {
    const r = loginOrRegister("selfcheck+1a@check.internal", "Selfcheck66");
    if (!r.ok) throw new Error(r.error);
    claimGift(r.user.id);
    recharge(r.user.id, 0);
    db().prepare("INSERT INTO redeem_codes (code, points, max_uses) VALUES ('SELFCHK123', 9, 10)").run();
    expect(cleanupSelfcheckData()).toBe(0);
    const d = db();
    expect((d.prepare("SELECT COUNT(*) n FROM ledger").get() as { n: number }).n).toBe(0);
    expect((d.prepare("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(0);
    expect(d.prepare("SELECT 1 FROM redeem_codes WHERE code='SELFCHK123'").get()).toBeUndefined();
    // KPI 残留核查:当日收入/注册归零
    expect((d.prepare("SELECT COALESCE(SUM(rmb),0) v FROM ledger WHERE kind='recharge'").get() as { v: number }).v).toBe(0);
    expect((d.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0);
  });
});
