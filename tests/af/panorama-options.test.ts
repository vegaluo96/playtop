import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

vi.mock("../../src/server/af/catalog", () => ({
  runAfEndpoint: vi.fn(async (key: string) => ({
    response: key === "injuries" ? [{ player: { name: "Injured Player", reason: "Knock" } }] : [],
  })),
}));

vi.mock("../../src/server/af/client", () => ({
  afGet: vi.fn(async () => ({ response: [] })),
}));

import { _resetDbForTest } from "../../src/server/db";
import { upsertFixture } from "../../src/server/af/store";
import { matchPanorama } from "../../src/server/af/panorama";
import { afGet } from "../../src/server/af/client";
import { runAfEndpoint } from "../../src/server/af/catalog";

function fixture(id: number) {
  return {
    fixture: {
      id,
      date: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      status: { short: "NS", elapsed: null },
    },
    league: { id: 39, season: 2026, name: "Premier League", round: "Regular Season - 1" },
    teams: { home: { id: 50, name: "Manchester City" }, away: { id: 42, name: "Arsenal" } },
    goals: { home: null, away: null },
    events: [],
  };
}

beforeEach(() => {
  _resetDbForTest();
  vi.mocked(afGet).mockClear();
  vi.mocked(runAfEndpoint).mockClear();
});

describe("matchPanorama options", () => {
  it("skips injuries endpoint when injuries are not needed", async () => {
    upsertFixture(fixture(901));

    const p = await matchPanorama(901, { injuries: false });

    expect(p?.injuries).toEqual([]);
    expect(runAfEndpoint).not.toHaveBeenCalled();
    expect(afGet).not.toHaveBeenCalled();
  });

  it("loads injuries by default for detail and unlocked report views", async () => {
    upsertFixture(fixture(902));

    const p = await matchPanorama(902);

    expect(p?.injuries).toEqual([{ player: { name: "Injured Player", reason: "Knock" } }]);
    expect(runAfEndpoint).toHaveBeenCalledWith("injuries", { fixture: "902" });
    expect(afGet).not.toHaveBeenCalled();
  });
});
