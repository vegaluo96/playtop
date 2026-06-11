/** 报告版本化:开赛锁定 / 预生成判定(预算·冷却·需求门控)/ 版本读取 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";
process.env.LLM_API_KEY = "test-key";

import { db, _resetDbForTest } from "../../src/server/db";
import { getReportVersion, listReportVersions, reportLocked, shouldPregenReport } from "../../src/server/llm/report";

const now = Date.parse("2026-06-11T12:00:00Z");
const day = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);

beforeEach(() => {
  _resetDbForTest();
  db();
});

describe("reportLocked(开赛即锁定)", () => {
  it("未开赛族不锁,其余全锁", () => {
    expect(reportLocked("NS")).toBe(false);
    expect(reportLocked("TBD")).toBe(false);
    expect(reportLocked("1H")).toBe(true);
    expect(reportLocked("HT")).toBe(true);
    expect(reportLocked("FT")).toBe(true);
  });
});

describe("shouldPregenReport", () => {
  const ko = (h: number) => now + h * 3_600_000;

  it("免费场 T-24h 内允许预生成;T-24h 外/已开赛不生成", () => {
    db().prepare("INSERT INTO free_fixtures (date, fixture_id) VALUES (?, 9)").run(day);
    expect(shouldPregenReport(9, ko(10), "NS", now)).toBe(true);
    expect(shouldPregenReport(9, ko(30), "NS", now)).toBe(false); // 距开赛 30h
    expect(shouldPregenReport(9, ko(-1), "1H", now)).toBe(false); // 已开赛锁定
  });

  it("无需求场次仅临场 2h 内生成", () => {
    expect(shouldPregenReport(8, ko(10), "NS", now)).toBe(false); // 非免费、无人解锁
    expect(shouldPregenReport(8, ko(1.5), "NS", now)).toBe(true); // T-2h 内
  });

  it("有人解锁过即视为有需求", () => {
    db().prepare("INSERT INTO unlocks (user_id, fixture_id, price, created_at) VALUES (1, 7, 38, ?)").run(now);
    expect(shouldPregenReport(7, ko(10), "NS", now)).toBe(true);
  });

  it("距上版 <30min 冷却不生成", () => {
    db().prepare("INSERT INTO free_fixtures (date, fixture_id) VALUES (?, 9)").run(day);
    db().prepare(
      "INSERT INTO report_versions (fixture_id, ver, fingerprint, content, gen_at) VALUES (9, 1, 'fp', '[]', ?)",
    ).run(now - 10 * 60_000);
    expect(shouldPregenReport(9, ko(10), "NS", now)).toBe(false);
    db().prepare("UPDATE report_versions SET gen_at = ? WHERE fixture_id = 9").run(now - 31 * 60_000);
    expect(shouldPregenReport(9, ko(10), "NS", now)).toBe(true);
  });
});

describe("版本读取", () => {
  it("listReportVersions 按版本序返回 changed;getReportVersion 取回内容", () => {
    const ins = db().prepare(
      "INSERT INTO report_versions (fixture_id, ver, fingerprint, content, model, gen_at, changed) VALUES (9,?,?,?,?,?,?)",
    );
    ins.run(1, "fp1", JSON.stringify([{ h: "盘口解读", ps: ["a"] }]), "m", now - 7200_000, "[]");
    ins.run(2, "fp2", JSON.stringify([{ h: "盘口解读", ps: ["b"] }]), "m", now - 3600_000, JSON.stringify(["盘口解读"]));
    const vs = listReportVersions(9);
    expect(vs.map((v) => v.ver)).toEqual([1, 2]);
    expect(vs[1].changed).toEqual(["盘口解读"]);
    expect(getReportVersion(9, 1)?.sections[0].ps).toEqual(["a"]);
    expect(getReportVersion(9, 99)).toBeNull();
  });
});
