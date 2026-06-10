import { describe, expect, it } from "vitest";

import { buildOddsFromAi } from "@/server/datasources/aiOdds";
import { CN_TEAM_EN, parseSportteryJson } from "@/server/datasources/sporttery";

describe("AI 检索盘口校验（三道闸）", () => {
  const good = {
    found: true,
    bookmaker: "bet365",
    oneXTwo: { home: 1.65, draw: 3.9, away: 5.5 },
    ou: [{ line: 2.5, over: 1.9, under: 1.9 }],
    ah: [{ line: -0.5, home: 1.85, away: 1.95 }],
  };

  it("可信赔率通过并组装为归一化 payload", () => {
    const p = buildOddsFromAi(good, 123);
    expect(p).not.toBeNull();
    expect(p!.oneXTwo).toEqual(good.oneXTwo);
    expect(p!.ou).toHaveLength(1);
    expect(p!.ah).toHaveLength(1);
    expect(p!.capturedAt).toBe(123);
  });

  it("found=false 或缺 1X2 → 整组拒收", () => {
    expect(buildOddsFromAi({ ...good, found: false }, 0)).toBeNull();
    expect(buildOddsFromAi({ ...good, oneXTwo: null }, 0)).toBeNull();
  });

  it("1X2 隐含概率和越界（编造特征）→ 整组拒收", () => {
    // 概率和 ≈ 0.77，市场上不存在这种无水盘
    expect(buildOddsFromAi({ ...good, oneXTwo: { home: 3, draw: 4, away: 6 } }, 0)).toBeNull();
    // 概率和 ≈ 1.74，水位荒谬
    expect(buildOddsFromAi({ ...good, oneXTwo: { home: 1.2, draw: 2.5, away: 1.9 } }, 0)).toBeNull();
  });

  it("ou/ah 单项不可信只丢弃该项，不影响整组", () => {
    const p = buildOddsFromAi(
      {
        ...good,
        ou: [
          { line: 2.5, over: 1.9, under: 1.9 },
          { line: 2.43, over: 1.9, under: 1.9 }, // 非 0.25 倍数盘口线
        ],
        ah: [{ line: -0.5, home: 1.05, away: 1.06 }], // 两向概率和荒谬
      },
      0,
    );
    expect(p!.ou).toHaveLength(1);
    expect(p!.ah).toHaveLength(0);
  });
});

describe("竞彩接口解析（结构防御）", () => {
  const sample = JSON.stringify({
    errorCode: "0",
    value: {
      matchInfoList: [
        {
          matchDate: "2026-06-11",
          matchTime: "21:00",
          leagueAllName: "世界杯",
          homeTeamAllName: "墨西哥",
          awayTeamAllName: "南非",
          had: { h: "1.65", d: "3.90", a: "5.50" },
        },
        {
          // 嵌套一层的日期分组变体
          subList: [
            {
              matchDate: "2026-06-12",
              matchTime: "03:00:00",
              leagueAbbName: "世界杯",
              hostTeamAllName: "韩国",
              guestTeamAllName: "捷克",
              had: { h: "2.80", d: "3.10", a: "2.60" },
            },
          ],
        },
        {
          matchDate: "2026-06-13",
          leagueAllName: "巴甲",
          homeTeamAllName: "弗拉门戈",
          awayTeamAllName: "帕尔梅拉斯",
          had: { h: "0", d: "", a: null }, // 未开售
        },
      ],
    },
  });

  it("两种层级结构都能抽出比赛；北京时间换算 UTC 正确", () => {
    const rows = parseSportteryJson(sample);
    expect(rows).toHaveLength(3);
    // 21:00 北京 = 13:00 UTC
    expect(rows[0].kickoffAt).toBe(Date.UTC(2026, 5, 11, 13, 0));
    expect(rows[0].oneXTwo).toEqual({ home: 1.65, draw: 3.9, away: 5.5 });
    expect(rows[0].homeEn).toBe("Mexico");
    expect(rows[0].awayEn).toBe("South Africa");
    // 03:00 北京 = 前一天 19:00 UTC（跨日）
    expect(rows[1].kickoffAt).toBe(Date.UTC(2026, 5, 11, 19, 0));
    expect(rows[1].homeEn).toBe("South Korea");
    expect(rows[1].awayEn).toBe("Czech Republic");
  });

  it("无赔率/未映射队伍：保留记录但标 null（调用方跳过）", () => {
    const rows = parseSportteryJson(sample);
    expect(rows[2].oneXTwo).toBeNull();
    expect(rows[2].homeEn).toBeNull();
    // 没给钟点 → hasTime=false（匹配放宽到同一天）
    expect(rows[2].hasTime).toBe(false);
  });

  it("48 队中文名映射齐全（含常见变体）", () => {
    expect(CN_TEAM_EN["美国"]).toBe("United States");
    expect(CN_TEAM_EN["波黑"]).toBe("Bosnia and Herzegovina");
    expect(CN_TEAM_EN["沙特"]).toBe("Saudi Arabia");
    expect(CN_TEAM_EN["刚果金"]).toBe("DR Congo");
    expect(CN_TEAM_EN["科特迪瓦"]).toBe("Ivory Coast");
    // 全部 48 队的英文名都应是历史库已核对口径（去重后 ≥48）
    expect(new Set(Object.values(CN_TEAM_EN)).size).toBeGreaterThanOrEqual(48);
  });
});
