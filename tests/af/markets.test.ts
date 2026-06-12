/** 扩展玩法解析:书商优先级 / 中文化 / 波胆赔率排序 / 半场盘 handicap 拼接 */
import { describe, expect, it } from "vitest";
import { parseExtraMarkets } from "../../src/server/af/markets";

const item = {
  bookmakers: [
    {
      id: 99,
      name: "SomeBook",
      bets: [
        { id: 13, name: "First Half Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "2.20" }, { value: "Away", odd: "4.00" }] },
      ],
    },
    {
      id: 8,
      name: "Bet365",
      bets: [
        { id: 13, name: "First Half Winner", values: [{ value: "Home", odd: "2.05" }, { value: "Draw", odd: "2.25" }, { value: "Away", odd: "4.10" }] },
        { id: 8, name: "Both Teams Score", values: [{ value: "Yes", odd: "1.80" }, { value: "No", odd: "1.95" }] },
        { id: 21, name: "Odd/Even", values: [{ value: "Odd", odd: "1.90" }, { value: "Even", odd: "1.86" }] },
        {
          id: 10, name: "Exact Score",
          values: [
            { value: "2:1", odd: "9.50" }, { value: "1:0", odd: "6.00" }, { value: "0:0", odd: "8.00" },
            { value: "5:4", odd: "251.00" }, { value: "1:1", odd: "5.50" },
          ],
        },
        {
          id: 45, name: "Corners Over Under",
          values: [{ value: "Over", handicap: "9.5", odd: "1.85" }, { value: "Under", handicap: "9.5", odd: "1.91" }],
        },
        {
          id: 7, name: "HT/FT Double",
          values: [{ value: "Home/Home", odd: "2.50" }, { value: "Home/Draw", odd: "15.00" }, { value: "Draw/Home", odd: "5.00" }, { value: "Away/Away", odd: "9.00" }],
        },
      ],
    },
  ],
};

describe("parseExtraMarkets", () => {
  const out = parseExtraMarkets(item);
  const get = (k: string) => out.find((m) => m.key === k);

  it("书商优先级:同玩法优先 Bet365,不取先出现的杂牌", () => {
    expect(get("fh1x2")?.bk).toBe("Bet365");
    expect(get("fh1x2")?.rows[0]).toEqual({ v: "主", odd: "2.05" });
  });

  it("值中文化:是/否、单/双、半全场组合", () => {
    expect(get("btts")?.rows.map((r) => r.v)).toEqual(["是", "否"]);
    expect(get("oddeven")?.rows.map((r) => r.v)).toEqual(["单", "双"]);
    expect(get("htft")?.rows[0].v).toBe("主/主");
    // 关键歧义:半全场 Home/Draw = 主/平(不能译成双重机会口径的「主或平」)
    expect(get("htft")?.rows.map((r) => r.v)).not.toContain("主或平");
    expect(get("htft")?.rows.map((r) => r.v)).toContain("主/平");
  });

  it("波胆按赔率升序取前 N(热门比分在前)", () => {
    const rows = get("exact")!.rows;
    expect(rows[0]).toEqual({ v: "1:1", odd: "5.50" });
    expect(rows.map((r) => r.v)).not.toContain(undefined);
  });

  it("角球盘 handicap 拼入标签", () => {
    expect(get("corners")?.rows.map((r) => r.v)).toEqual(["大 9.5", "小 9.5"]);
  });

  it("空/坏输入安全", () => {
    expect(parseExtraMarkets({})).toEqual([]);
    expect(parseExtraMarkets(null)).toEqual([]);
  });
});
