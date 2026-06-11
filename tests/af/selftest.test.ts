import { describe, expect, it } from "vitest";
import { AF_ENDPOINTS } from "@/server/af/catalog";
import { paramsFor, type SelftestContext } from "@/server/af/selftest";

const FULL: SelftestContext = {
  league: "39",
  season: "2023",
  team: "33",
  fixture: "867946",
  home: "33",
  away: "34",
  player: "276",
  coach: "18",
};
const BARE: SelftestContext = { league: "39", season: "2023" };

describe("selftest 计划覆盖全部 39 端点", () => {
  it("完整上下文下，每个端点都有参数计划（无 undefined，一个不漏）", () => {
    for (const ep of AF_ENDPOINTS) {
      const p = paramsFor(ep.key, FULL);
      expect(p, `端点 ${ep.key} 未登记 selftest 参数`).not.toBe(undefined);
      expect(p, `端点 ${ep.key} 完整上下文不应被跳过`).not.toBeNull();
    }
  });

  it("依赖型端点在缺 ID 时跳过（返回 null），不会瞎打必失败的请求", () => {
    // 这些端点必须有 fixture/team/player 才有意义
    for (const k of ["fixtures.statistics", "predictions", "teams.statistics", "players.squads", "players.teams", "trophies", "sidelined", "fixtures.headtohead"]) {
      expect(paramsFor(k, BARE), `${k} 缺依赖应跳过`).toBeNull();
    }
  });

  it("无依赖端点即便空上下文也照常跑", () => {
    for (const k of ["status", "timezone", "countries", "leagues", "standings", "fixtures", "odds.bets", "odds.live"]) {
      expect(paramsFor(k, BARE), `${k} 不应被跳过`).not.toBeNull();
    }
  });

  it("必填参数确实被带上（与目录的 required 对齐）", () => {
    expect(paramsFor("teams.statistics", FULL)).toMatchObject({ league: "39", season: "2023", team: "33" });
    expect(paramsFor("predictions", FULL)).toMatchObject({ fixture: "867946" });
    expect(paramsFor("fixtures.headtohead", FULL)!.h2h).toBe("33-34");
    expect(paramsFor("players.topscorers", FULL)).toMatchObject({ league: "39", season: "2023" });
  });
});
