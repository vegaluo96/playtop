import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@/server/db/migrate";
import { createManualMatch } from "@/server/services/matchesService";
import { insertSnapshot, latestOddsBookRows, latestOddsBooks } from "@/server/services/snapshots";

let matchId: number;

const odds = (bookmaker: string, home: number, capturedAt: number) => ({
  bookmaker,
  oneXTwo: { home, draw: 3.9, away: 5.5 },
  ou: [],
  ah: [],
  capturedAt,
});

beforeAll(() => {
  runMigrations();
  matchId = createManualMatch({
    leagueCode: "WC2026",
    homeName: "Mexico",
    awayName: "South Africa",
    kickoffAt: Date.now() + 86_400_000,
    neutral: false,
  });
});

describe("盘口快照：多书商并存与去重", () => {
  it("不同书商交替写入互不覆盖、互不触发去重", () => {
    const a = insertSnapshot(matchId, "odds", "manual", odds("bet365", 1.65, 1000));
    const b = insertSnapshot(matchId, "odds", "manual", odds("Polymarket", 1.7, 2000));
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(true);
    // 同家同价（仅 capturedAt 不同）→ 去重，不新增（修复了原来时间戳进哈希的 bug）
    const a2 = insertSnapshot(matchId, "odds", "manual", odds("bet365", 1.65, 3000));
    expect(a2.changed).toBe(false);
    expect(a2.id).toBe(a.id);
  });

  it("同家价格变化才新增一行", () => {
    const moved = insertSnapshot(matchId, "odds", "manual", odds("bet365", 1.6, 4000));
    expect(moved.changed).toBe(true);
  });

  it("latestOddsBooks 返回每家最新一份", () => {
    const rows = latestOddsBookRows(matchId);
    expect(rows.map((r) => r.bookmaker).sort()).toEqual(["Polymarket", "bet365"]);
    const books = latestOddsBooks(matchId);
    const b365 = books.find((b) => b.bookmaker === "bet365")!;
    expect(b365.oneXTwo!.home).toBe(1.6); // 取到改价后的最新
  });
});

describe("盘口一致性窗口：死源残留剔除", () => {
  afterAll(() => {
    delete process.env.FAKE_NOW;
  });

  it("某家最新快照比全场最新旧 6h+ → 不再进入各家最新口径", () => {
    const T0 = Date.now();
    process.env.FAKE_NOW = String(T0);
    const id = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Ghana",
      awayName: "Uruguay",
      kickoffAt: T0 + 86_400_000,
      neutral: true,
    });
    insertSnapshot(id, "odds", "manual", odds("已停更源", 2.4, T0));
    insertSnapshot(id, "odds", "manual", odds("bet365", 2.0, T0));
    expect(latestOddsBooks(id).map((b) => b.bookmaker).sort()).toEqual(["bet365", "已停更源"]);
    // 7 小时后只有 bet365 更新了 → 停更源被一致性窗口剔除
    process.env.FAKE_NOW = String(T0 + 7 * 3_600_000);
    insertSnapshot(id, "odds", "manual", odds("bet365", 1.9, T0 + 7 * 3_600_000));
    const books = latestOddsBooks(id);
    expect(books.map((b) => b.bookmaker)).toEqual(["bet365"]);
    expect(books[0].oneXTwo!.home).toBe(1.9);
  });
});
