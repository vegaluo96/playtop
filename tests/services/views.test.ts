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
