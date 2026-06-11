import { describe, expect, it } from "vitest";
import { AF_ENDPOINTS, afCatalogGrouped, afEndpointByKey, runAfEndpoint } from "@/server/datasources/afCatalog";

describe("AF v3 端点全目录", () => {
  it("端点 key 唯一，且每个都有路径/中文名/说明", () => {
    const keys = new Set<string>();
    for (const e of AF_ENDPOINTS) {
      expect(keys.has(e.key), `重复 key: ${e.key}`).toBe(false);
      keys.add(e.key);
      expect(e.path.startsWith("/"), `${e.key} 路径应以 / 开头`).toBe(true);
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.doc.length).toBeGreaterThan(0);
    }
  });

  it("覆盖文档全部主要端点（一个不能少）", () => {
    // 抽样核验关键端点都在目录中
    for (const k of [
      "status", "timezone", "countries", "venues", "leagues", "leagues.seasons",
      "teams", "teams.statistics", "teams.seasons", "teams.countries",
      "standings", "fixtures", "fixtures.rounds", "fixtures.headtohead",
      "fixtures.statistics", "fixtures.events", "fixtures.lineups", "fixtures.players",
      "injuries", "predictions", "sidelined", "coachs",
      "players", "players.seasons", "players.profiles", "players.squads", "players.teams",
      "players.topscorers", "players.topassists", "players.topyellowcards", "players.topredcards",
      "transfers", "trophies",
      "odds", "odds.mapping", "odds.bookmakers", "odds.bets", "odds.live", "odds.live.bets",
    ]) {
      expect(afEndpointByKey(k), `缺端点 ${k}`).toBeDefined();
    }
  });

  it("分组目录总数与扁平目录一致", () => {
    const grouped = afCatalogGrouped();
    const total = grouped.reduce((s, g) => s + g.endpoints.length, 0);
    expect(total).toBe(AF_ENDPOINTS.length);
  });

  it("缺必填参数本地拦截（不触网）", async () => {
    await expect(runAfEndpoint("teams.statistics", {})).rejects.toThrow(/必填/);
  });

  it("未知端点拒绝", async () => {
    await expect(runAfEndpoint("does.not.exist", {})).rejects.toThrow(/未知端点/);
  });
});
