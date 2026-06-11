import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@/server/db/migrate";
import { createManualMatch } from "@/server/services/matchesService";
import { getUpcomingFixture, listMatchCards } from "@/server/services/views";

const T0 = Date.UTC(2026, 5, 10, 12, 0);

beforeAll(() => {
  process.env.FAKE_NOW = String(T0);
  runMigrations();
});

afterAll(() => {
  delete process.env.FAKE_NOW;
});

describe("用户端赛程可见性（世界杯冷启动场景）", () => {
  it("未发布的未来 14 天内场次上首页；更远的不上", () => {
    const soon = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Mexico",
      awayName: "South Africa",
      kickoffAt: T0 + 3 * 86_400_000,
      neutral: false,
    });
    const far = createManualMatch({
      leagueCode: "WC2026",
      homeName: "England",
      awayName: "Croatia",
      kickoffAt: T0 + 20 * 86_400_000,
      neutral: true,
    });
    const cards = listMatchCards(null);
    const ids = cards.map((c) => c.id);
    expect(ids).toContain(soon);
    expect(ids).not.toContain(far);
    const card = cards.find((c) => c.id === soon)!;
    expect(card.status).toBe("scheduled");
    expect(card.stars).toBeNull(); // 未发布无评级
  });

  it("免费公测：匿名访客可读全文；关闭后回到锁定态", async () => {
    const { setConfig } = await import("@/server/lib/config");
    const { insertSnapshot } = await import("@/server/services/snapshots");
    const { transitionMatch } = await import("@/server/services/matchesService");
    const { analyzeMatch, latestAnalysis } = await import("@/server/services/analyze");
    const { publishAnalysisRow } = await import("@/server/services/publish");
    const { getMatchDetail } = await import("@/server/services/views");

    const id = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Brazil",
      awayName: "Chile",
      kickoffAt: T0 + 6 * 3_600_000,
      neutral: true,
    });
    insertSnapshot(id, "odds", "manual", {
      bookmaker: "bet365",
      oneXTwo: { home: 1.7, draw: 3.8, away: 5.2 },
      ou: [],
      ah: [],
      capturedAt: T0,
    });
    transitionMatch(id, "collecting");
    transitionMatch(id, "ready");
    await analyzeMatch(id);
    publishAnalysisRow(latestAnalysis(id)!.id, {});

    setConfig("pricing", { freeBeta: true });
    const open = getMatchDetail(id, null)!;
    expect(open.access).toBe("unlocked");
    expect(open.engine).not.toBeNull();
    expect(open.card.verdict).not.toBeNull();

    expect(open.intel).not.toBeNull(); // 情报面板随解锁态可见

    setConfig("pricing", { freeBeta: false });
    const locked = getMatchDetail(id, null)!;
    expect(locked.access).toBe("locked");
    expect(locked.engine).toBeNull();
    expect(locked.intel).toBeNull(); // 锁定态不泄露情报
    setConfig("pricing", { freeBeta: true });
  });

  it("getUpcomingFixture：未发布场次返回赛程视图，含默认解锁价", () => {
    const id = createManualMatch({
      leagueCode: "WC2026",
      homeName: "Japan",
      awayName: "Tunisia",
      kickoffAt: T0 + 5 * 86_400_000,
      neutral: true,
    });
    const up = getUpcomingFixture(id)!;
    expect(up.homeName).toBe("Japan");
    expect(up.pricePoints).toBeGreaterThan(0);
    expect(getUpcomingFixture(999999)).toBeNull();
  });
});
