import { describe, expect, it } from "vitest";

import { parseClubEloCsv, parseEloRatingsTsv, findRating } from "@/server/datasources/externalRatings";
import { buildSmarketsQuotes, smarketsToOneXTwo } from "@/server/datasources/predictionMarkets";
import { parseUnderstatTeams } from "@/server/datasources/understat";
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

describe("预测市场与交易所", () => {

  it("Smarkets：万分数报价 → 十进制赔率（最低 offer = 最高可买赔率）", () => {
    const contracts = JSON.stringify({
      contracts: [
        { id: "c1", name: "Mexico" },
        { id: "c2", name: "Draw" },
        { id: "c3", name: "South Africa" },
      ],
    });
    const quotes = JSON.stringify({
      c1: { offers: [{ price: 5800 }, { price: 6000 }] },
      c2: { offers: [{ price: 2500 }] },
      c3: { offers: [{ price: 1800 }] },
    });
    const qs = buildSmarketsQuotes(contracts, quotes);
    const odds = smarketsToOneXTwo(qs, { homeNames: ["Mexico"], awayNames: ["South Africa"] }, 3)!;
    expect(odds.bookmaker).toBe("Smarkets（交易所）");
    expect(odds.oneXTwo!.home).toBeCloseTo(10000 / 5800, 4);
    expect(odds.oneXTwo!.draw).toBeCloseTo(4, 4);
  });

  it("indicative 书商进共识（低权重）但不进最优价", () => {
    const real = { bookmaker: "bet365", oneXTwo: { home: 2.0, draw: 3.4, away: 3.8 }, ou: [], ah: [], capturedAt: 0 };
    const sim = { bookmaker: "参考盘（模拟）", oneXTwo: { home: 2.6, draw: 3.4, away: 3.0 }, ou: [], ah: [], indicative: true, capturedAt: 0 };
    const best = bestOneXTwo([real, sim])!;
    expect(best.home.bookmaker).toBe("bet365"); // 模拟盘 2.6 更高但不可成交
    const consensus = consensusProbs(devigBooks([real, sim]), { "参考盘（模拟）": 0.3 })!;
    expect(consensus.detail.find((d) => d.bookmaker === "参考盘（模拟）")!.weight).toBeCloseTo(0.3);
    const sum = consensus.probs.home + consensus.probs.draw + consensus.probs.away;
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("Understat 与 martj42 数据集", () => {
  it("understat HTML 内嵌 JSON（\\xNN 转义）抽取", () => {
    const inner = JSON.stringify({
      "89": { title: "Manchester City", history: [{ xG: 2.1, xGA: 0.4 }, { xG: 1.7, xGA: 1.1 }] },
    }).replace(/"/g, "\\x22");
    const html = `<script>var teamsData = JSON.parse('${inner}');</script>`;
    const rows = parseUnderstatTeams(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].xG).toBeCloseTo(3.8);
    expect(rows[0].matches).toBe(2);
  });

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
