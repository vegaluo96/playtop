import { describe, expect, it } from "vitest";

import { parseClubEloCsv, parseEloRatingsTsv, findRating } from "@/server/datasources/externalRatings";
import { buildIntlPlayerStats, parseGoalscorers, parseShootouts } from "@/server/datasources/githubIntl";
import { consensusProbs, devigBooks, bestOneXTwo } from "@/server/engine/consensus";

const KICKOFF = Date.UTC(2026, 5, 11, 19, 0);

describe("外部评级解析", () => {
  it("eloratings TSV 防御解析 + 队名匹配", () => {
    const tsv = "1\tARG\tArgentina\t2143\n2\tFRA\tFrance\t2077\n47\tKOR\tSouth Korea\t1742\n";
    const rows = parseEloRatingsTsv(tsv);
    expect(rows.length).toBe(3);
    const arg = findRating(rows, ["Argentina"]);
    expect(arg!.rating).toBe(2143);
    expect(arg!.rank).toBe(1);
  });

  it("ClubElo CSV 解析", () => {
    const csv = "Rank,Club,Country,Level,Elo,From,To\n1,Liverpool,ENG,1,2044.5,2026-06-10,2026-06-11\n2,Man City,ENG,1,2010.1,2026-06-10,2026-06-11\n";
    const rows = parseClubEloCsv(csv);
    expect(rows).toHaveLength(2);
    expect(findRating(rows, ["Man City"])!.rating).toBeCloseTo(2010.1);
  });
});

describe("martj42 国际赛数据集", () => {

  it("射手榜+点球大战事实生成（近3年过滤、Top5、点球标注）", () => {
    const scorers = parseGoalscorers(
      [
        "date,home_team,away_team,team,scorer,minute,own_goal,penalty",
        "2025-06-01,Mexico,Chile,Mexico,Raúl Jiménez,10,FALSE,TRUE",
        "2025-06-01,Mexico,Chile,Mexico,Raúl Jiménez,50,FALSE,FALSE",
        "2019-06-01,Mexico,Chile,Mexico,Old Player,10,FALSE,FALSE", // 超出3年窗口
        "2025-07-01,South Africa,Egypt,South Africa,Percy Tau,30,FALSE,FALSE",
      ].join("\n"),
    );
    const shootouts = parseShootouts(
      ["date,home_team,away_team,winner,first_shooter", "2021-07-01,Mexico,Brazil,Mexico,"].join("\n"),
    );
    const payload = buildIntlPlayerStats(scorers, shootouts, "Mexico", "South Africa", Date.UTC(2026, 5, 10));
    const mex = payload.items.filter((i) => i.team === "home");
    expect(mex).toHaveLength(1);
    expect(mex[0].player).toBe("Raúl Jiménez");
    expect(mex[0].goals).toBe(2);
    expect(mex[0].note).toContain("点球1");
    expect(payload.items.filter((i) => i.team === "away")[0].player).toBe("Percy Tau");
    expect(payload.notes!.some((n) => n.includes("点球大战 1 次，胜 1 次"))).toBe(true);
  });
});
