import { describe, expect, it } from "vitest";

import {
  WC_TEAM_FIX,
  parseFootballTxt,
  wcCityCountry,
  wcNeutral,
  wcRoundCn,
} from "@/server/datasources/openfootballWorldCup";

/** 取自 openfootball/worldcup 2026--usa/cup.txt 的真实片段 */
const GROUPS_SAMPLE = `= World Cup 2026      # in Canada, USA, and Mexico

#  104 matches featuring 48 teams played across 16 host cities in three countries

Group A | Mexico        South Africa    South Korea    Czech Republic
Group B | Canada      Bosnia & Herzegovina  Qatar    Switzerland

## change to only three matchdays in group stage - why? why not?
##  ▪ Matchday 1 | Jun 11-17

▪ Matchday 1 | Thu Jun 11
▪ Matchday 2 | Fri Jun 12

▪ Group A
Thu June 11
  13:00 UTC-6     Mexico       v South Africa        @ Mexico City
  20:00 UTC-6     South Korea  v Czech Republic     @ Guadalajara (Zapopan)
Thu June 18
  12:00 UTC-4     Czech Republic    v South Africa   @ Atlanta

▪ Group B
Fri June 12
  15:00 UTC-4     Canada   v Bosnia & Herzegovina    @ Toronto
`;

/** 取自 cup_finals.txt 的真实片段（含占位符与场次编号） */
const FINALS_SAMPLE = `= World Cup 2026       # in Canada, USA, and Mexico

## W74         =  Winner match 74

▪ Round of 32
Sun Jun 28
  (73) 12:00 UTC-7  2A v 2B           @ Los Angeles (Inglewood)
Mon Jun 29
  (74) 16:30 UTC-4  1E v 3A/B/C/D/F   @ Boston (Foxborough)

▪ Semi-final
Tue Jul 14
 (101) 14:00 UTC-5  W97 v W98   @ Dallas (Arlington)

▪ Final
Sun Jul 19
  (104) 15:00 UTC-4    Spain v Argentina    @ New York/New Jersey (East Rutherford)
`;

describe("openfootball Football.TXT 解析", () => {
  it("解析小组赛：轮次/队名/城市/UTC 换算正确，注记与分组定义行被跳过", () => {
    const fx = parseFootballTxt(GROUPS_SAMPLE, 2026);
    expect(fx).toHaveLength(4);

    expect(fx[0].round).toBe("Group A");
    expect(fx[0].homeTeam).toBe("Mexico");
    expect(fx[0].awayTeam).toBe("South Africa");
    expect(fx[0].city).toBe("Mexico City");
    expect(fx[0].matchNo).toBeNull();
    expect(fx[0].pending).toBe(false);
    // 13:00 UTC-6 → 19:00 UTC
    expect(fx[0].kickoffAt).toBe(Date.UTC(2026, 5, 11, 19, 0));

    expect(fx[1].homeTeam).toBe("South Korea");
    expect(fx[1].city).toBe("Guadalajara (Zapopan)");

    // 12:00 UTC-4 → 16:00 UTC（同一组内日期切换）
    expect(fx[2].kickoffAt).toBe(Date.UTC(2026, 5, 18, 16, 0));

    expect(fx[3].round).toBe("Group B");
    expect(fx[3].awayTeam).toBe("Bosnia & Herzegovina");
  });

  it("解析淘汰赛：场次编号、占位符标记、缩写月份", () => {
    const fx = parseFootballTxt(FINALS_SAMPLE, 2026);
    expect(fx).toHaveLength(4);

    expect(fx[0].matchNo).toBe(73);
    expect(fx[0].pending).toBe(true); // 2A v 2B
    expect(fx[0].kickoffAt).toBe(Date.UTC(2026, 5, 28, 19, 0)); // 12:00 UTC-7

    expect(fx[1].matchNo).toBe(74);
    expect(fx[1].pending).toBe(true); // 3A/B/C/D/F 含斜杠

    expect(fx[2].matchNo).toBe(101);
    expect(fx[2].pending).toBe(true); // W97 v W98
    expect(fx[2].round).toBe("Semi-final");

    expect(fx[3].matchNo).toBe(104);
    expect(fx[3].pending).toBe(false); // 决赛对阵已定（测试样例）
    expect(fx[3].round).toBe("Final");
    expect(fx[3].homeTeam).toBe("Spain");
    expect(fx[3].kickoffAt).toBe(Date.UTC(2026, 6, 19, 19, 0)); // 15:00 UTC-4
  });

  it("队名映射：与 martj42 历史库不一致的两个名字", () => {
    expect(WC_TEAM_FIX["USA"]).toBe("United States");
    expect(WC_TEAM_FIX["Bosnia & Herzegovina"]).toBe("Bosnia and Herzegovina");
  });

  it("城市国别与中立场判定：东道主主场非中立，其余中立", () => {
    expect(wcCityCountry("Mexico City")).toBe("MX");
    expect(wcCityCountry("Toronto")).toBe("CA");
    expect(wcCityCountry("Atlanta")).toBe("US");

    expect(wcNeutral("Mexico", "Mexico City")).toBe(false);
    expect(wcNeutral("Canada", "Toronto")).toBe(false);
    expect(wcNeutral("United States", "Seattle")).toBe(false);
    // 东道主列为客队 → 不给对手主场优势，按中立
    expect(wcNeutral("Czech Republic", "Mexico City")).toBe(true);
    expect(wcNeutral("Mexico", "Atlanta")).toBe(true);
  });

  it("轮次中文化", () => {
    expect(wcRoundCn("Group A")).toBe("A 组");
    expect(wcRoundCn("Round of 32")).toBe("32 强");
    expect(wcRoundCn("Quarter-final")).toBe("1/4 决赛");
    expect(wcRoundCn("Match for third place")).toBe("季军赛");
    expect(wcRoundCn("Final")).toBe("决赛");
  });
});
