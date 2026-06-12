/** 阵容朝向:门将在底、前锋在顶;AF 列 1=右侧 → 观众视角左→右正确 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest } from "../../src/server/db";
import { detailView } from "../../src/server/views/detail";
import type { Panorama } from "../../src/server/af/panorama";

beforeEach(() => _resetDbForTest());

// 曼城 4-1-4-1 真实 grid(Walker 2:1=右后卫 / Gvardiol 2:4=左后卫)
const startXI = [
  { player: { id: 1, name: "Ederson", number: 31, grid: "1:1" } },
  { player: { id: 2, name: "Walker", number: 2, grid: "2:1" } },
  { player: { id: 3, name: "Dias", number: 3, grid: "2:2" } },
  { player: { id: 4, name: "Akanji", number: 25, grid: "2:3" } },
  { player: { id: 5, name: "Gvardiol", number: 24, grid: "2:4" } },
  { player: { id: 6, name: "Rodri", number: 16, grid: "3:1" } },
  { player: { id: 7, name: "B.Silva", number: 20, grid: "4:1" } },
  { player: { id: 8, name: "De Bruyne", number: 17, grid: "4:2" } },
  { player: { id: 9, name: "Kovacic", number: 8, grid: "4:3" } },
  { player: { id: 10, name: "Foden", number: 47, grid: "4:4" } },
  { player: { id: 11, name: "Haaland", number: 9, grid: "5:1" } },
];

function panorama(): Panorama {
  const fx = {
    fixture_id: 1, league_id: 39, season: 2026, league_name: "PL", round: "", kickoff_utc: Date.now() + 3_600_000,
    status: "NS", elapsed: null, home_id: 50, home_name: "Manchester City", away_id: 42, away_name: "Arsenal",
    goals_home: null, goals_away: null, payload: "{}", updated_at: Date.now(),
  };
  const lineup = (teamId: number) => ({ team: { id: teamId }, formation: "4-1-4-1", coach: { name: "Guardiola" }, startXI, substitutes: [] });
  return {
    fixture: fx as never,
    bundle: { lineups: [lineup(50), lineup(42)] },
    odds: { ah: [], ou: [], eu: [], compareAh: [], compareOu: [], compareEu: [] } as never,
    movements: [], prediction: null, injuries: [], deep: null as never,
  };
}

describe("阵容朝向", () => {
  it("门将在最后一行(底),前锋在第一行(顶)", async () => {
    const v = await detailView(panorama(), "UTC+8", { deep: false });
    const rows = v.lineups.home.rows;
    expect(rows[0].map((p: { n: string }) => p.n)).toEqual(["哈兰德"]); // 顶=前锋
    expect(rows[rows.length - 1].map((p: { n: string }) => p.n)).toEqual(["埃德森"]); // 底=门将
  });

  it("后防线左→右:左后卫 Gvardiol 在最左,右后卫 Walker 在最右", async () => {
    const v = await detailView(panorama(), "UTC+8", { deep: false });
    const back = v.lineups.home.rows[3].map((p: { n: string }) => p.n); // 倒数第二行=后卫线
    expect(back[0]).toBe("格瓦迪奥尔"); // 最左 = 左后卫(grid 列 4)
    expect(back[back.length - 1]).toBe("沃克"); // 最右 = 右后卫(grid 列 1)
  });

  it("行数与阵型一致(4-1-4-1 → 含门将 5 行,人数 1/4/1/4/1 自顶到底为 1/4/1/4/1)", async () => {
    const v = await detailView(panorama(), "UTC+8", { deep: false });
    expect(v.lineups.home.rows.map((r: unknown[]) => r.length)).toEqual([1, 4, 1, 4, 1]);
  });
});
