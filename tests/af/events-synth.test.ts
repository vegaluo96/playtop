/** 统计差分合成事件:首帧只记基线、增量出带序号事件、状态切换落节点、大跳变不刷屏 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.PLAYTOP_DB = ":memory:";

import { _resetDbForTest } from "../../src/server/db";
import { synthEventsOf, synthFromFixture } from "../../src/server/af/events-synth";
import { timelineView } from "../../src/server/views/detail";
import type { FixtureRow } from "../../src/server/af/store";

beforeEach(() => _resetDbForTest());

function fx(over: Partial<FixtureRow> & { stats?: [string, number, number][]; payloadExtra?: Record<string, unknown> }): FixtureRow {
  const { stats, payloadExtra, ...rest } = over;
  const payload: Record<string, unknown> = { ...(payloadExtra ?? {}) };
  if (stats) {
    payload.statistics = [
      { team: { id: 100 }, statistics: stats.map(([type, h]) => ({ type, value: h })) },
      { team: { id: 200 }, statistics: stats.map(([type, , a]) => ({ type, value: a })) },
    ];
  }
  return {
    fixture_id: 7, league_id: 39, season: 2025, league_name: "Premier League", round: "1",
    kickoff_utc: 0, status: "1H", elapsed: 10, home_id: 100, home_name: "Arsenal",
    away_id: 200, away_name: "Chelsea", goals_home: 0, goals_away: 0,
    payload: JSON.stringify(payload), updated_at: 0,
    ...rest,
  } as FixtureRow;
}

describe("synthFromFixture", () => {
  it("首帧只记基线不补发历史;后续增量按队内序号出事件", () => {
    synthFromFixture(fx({ stats: [["Corner Kicks", 3, 1]], elapsed: 20 }));
    expect(synthEventsOf(7).filter((e) => e.kind === "corner")).toHaveLength(0); // 基线
    synthFromFixture(fx({ stats: [["Corner Kicks", 5, 1]], elapsed: 27 }));
    const corners = synthEventsOf(7).filter((e) => e.kind === "corner");
    expect(corners).toHaveLength(2);
    expect(corners.map((c) => c.seq)).toEqual([4, 5]); // 接着基线 3 继续编号
    expect(corners.every((c) => c.side === "h" && c.m === 27)).toBe(true);
  });

  it("状态切换落节点并附当时比分;无变化幂等零写入", () => {
    synthFromFixture(fx({ status: "1H", elapsed: 1 }));
    synthFromFixture(fx({ status: "1H", elapsed: 1 })); // 重复帧
    synthFromFixture(fx({ status: "HT", elapsed: 45, goals_home: 1, goals_away: 0 }));
    synthFromFixture(fx({ status: "2H", elapsed: 46, goals_home: 1, goals_away: 0 }));
    synthFromFixture(fx({ status: "FT", elapsed: 90, goals_home: 2, goals_away: 1 }));
    const nodes = synthEventsOf(7).filter((e) => e.side === "mid");
    expect(nodes.map((n) => n.kind)).toEqual(["kickoff", "ht", "2h", "ft"]);
    expect(nodes.find((n) => n.kind === "ht")?.score).toBe("1-0");
    expect(nodes.find((n) => n.kind === "ft")?.score).toBe("2-1");
  });

  it("单帧暴涨 >5(数据修正)不刷屏,只对齐计数", () => {
    synthFromFixture(fx({ stats: [["Shots on Goal", 0, 0]] }));
    synthFromFixture(fx({ stats: [["Shots on Goal", 9, 0]] }));
    expect(synthEventsOf(7).filter((e) => e.kind === "sot")).toHaveLength(5);
    synthFromFixture(fx({ stats: [["Shots on Goal", 10, 0]] }));
    const sots = synthEventsOf(7).filter((e) => e.kind === "sot");
    expect(sots[sots.length - 1].seq).toBe(10); // 计数已对齐到统计现值
  });
});

describe("timelineView", () => {
  const bundle = {
    events: [
      { type: "Goal", detail: "Normal Goal", time: { elapsed: 23, extra: null }, team: { id: 100 }, player: { name: "Saka" }, assist: { name: "Odegaard" } },
      { type: "Card", detail: "Yellow Card", time: { elapsed: 40, extra: null }, team: { id: 200 }, player: { name: "Caicedo" } },
      { type: "Goal", detail: "Normal Goal", time: { elapsed: 45, extra: 2 }, team: { id: 200 }, player: { name: "Palmer" } },
    ],
    score: { halftime: { home: 1, away: 1 } },
    statistics: [
      { team: { id: 100 }, statistics: [{ type: "Corner Kicks", value: 5 }] },
      { team: { id: 200 }, statistics: [{ type: "Corner Kicks", value: 2 }] },
    ],
  };
  const f = { status: "2H", elapsed: 60, home_id: 100, home_name: "Arsenal", away_name: "Chelsea", goals_home: 1, goals_away: 1 };

  it("真实事件编号比分 + 合成事件 + 状态节点兜底合并,最新在上", () => {
    const synth = [
      { m: 30, side: "h" as const, kind: "corner", seq: 4, at: 1 },
      { m: 46, side: "mid" as const, kind: "2h", score: "1-1", at: 2 },
    ];
    const tl = timelineView(bundle, f, synth);
    const kinds = tl.rows.map((r) => r.kind);
    // 倒序:2h 节点 > ht 兜底 > 45+2 进球 > 黄牌 > 角球 > 进球 > kickoff 兜底
    expect(kinds).toEqual(["2h", "ht", "goal", "yellow", "corner", "goal", "kickoff"]);
    const goals = tl.rows.filter((r) => r.kind === "goal");
    expect(goals[0].text).toContain("1-1"); // 帕尔默扳平后比分
    expect(goals[0].m).toBe("45+2'");
    expect(goals[1].text).toContain("1-0");
    expect(tl.rows.find((r) => r.kind === "ht")?.text).toContain("1-1"); // 半场比分兜底自 score.halftime
    expect(tl.rows.find((r) => r.kind === "corner")?.live).toContain("第 4 个角球");
    expect(tl.corners).toEqual({ h: 5, a: 2 });
  });

  it("乌龙/点球打标;未开赛不出节点", () => {
    const og = {
      events: [{ type: "Goal", detail: "Own Goal", time: { elapsed: 10, extra: null }, team: { id: 100 }, player: { name: "X" }, assist: {} }],
    };
    const tl = timelineView(og, { ...f, status: "1H", elapsed: 12 }, []);
    expect(tl.rows.find((r) => r.kind === "goal")?.text).toContain("乌龙");
    const pre = timelineView({}, { ...f, status: "NS", goals_home: null, goals_away: null }, []);
    expect(pre.rows).toHaveLength(0);
  });
});
