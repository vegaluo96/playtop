import { describe, expect, it } from "vitest";
import { AF_ENDPOINTS, afCatalogGrouped, afEndpointByKey, buildAfPath, runAfEndpoint } from "@/server/af/catalog";
import { afHasErrors } from "@/server/af/client";

describe("AF v3 端点全目录", () => {
  it("key 唯一，路径/中文名/说明齐全", () => {
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
    const total = afCatalogGrouped().reduce((s, g) => s + g.endpoints.length, 0);
    expect(total).toBe(AF_ENDPOINTS.length);
  });

  it("白名单组参：未声明参数被丢弃，空值被丢弃", () => {
    const ep = afEndpointByKey("predictions")!;
    expect(buildAfPath(ep, { fixture: "123", hack: "1", empty: "" })).toBe("/predictions?fixture=123");
    expect(buildAfPath(afEndpointByKey("status")!, { anything: "x" })).toBe("/status");
  });

  it("缺必填参数本地拦截（不触网）", async () => {
    await expect(runAfEndpoint("teams.statistics", {})).rejects.toThrow(/必填/);
  });

  it("未知端点拒绝", async () => {
    await expect(runAfEndpoint("does.not.exist", {})).rejects.toThrow(/未知端点/);
  });
});

describe("响应信封 errors 判定", () => {
  it("空对象/空数组/缺失 → 无错；非空对象或非空数组 → 有错", () => {
    expect(afHasErrors({})).toBe(false);
    expect(afHasErrors({ errors: {} })).toBe(false);
    expect(afHasErrors({ errors: [] })).toBe(false);
    expect(afHasErrors({ errors: { token: "invalid" } })).toBe(true);
    expect(afHasErrors({ errors: ["rate limit"] })).toBe(true);
  });
});
