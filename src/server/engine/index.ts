import { dcScoreMatrix, marketInversion, matrixToThreeWay } from "./dixonColes";
import { powerDevig, twoWayDevig } from "./devig";
import { bestAh, bestOneXTwo, bestOu, consensusProbs, devigBooks, pickMainOu } from "./consensus";
import { computeAdjustments } from "./adjustments";
import { logOpinionPool } from "./ensemble";
import { expectedValue, kellyStake } from "./kelly";
import { ahEv, ahHomeCover, ouEv, ouProbs, rescaleMatrixTo1x2, topScores } from "./markets";
import {
  ENGINE_MODEL_VERSION,
  engineOutputSchema,
  type EngineBundle,
  type EngineOutput,
  type EngineParams,
  type FallbackLevel,
  type ThreeWay,
} from "./types";

/**
 * 预测引擎唯一入口：纯函数、零 IO、无时钟、无随机。
 * 同一 bundle + params 永远得到同一 EngineOutput（可审计、可复现）。
 */
export function runEngine(bundle: EngineBundle, params: EngineParams): EngineOutput {
  const trace: string[] = [];
  const { match } = bundle;
  // 多家书商（缺省回落到单家 odds）：共识做市场成员，最优价做价值口径
  const books = bundle.books?.length ? bundle.books : bundle.odds ? [bundle.odds] : [];

  // ---------- 1. 市场基线（逐家 Shin 去水 → 中位数共识） ----------
  let market: EngineOutput["market"] = null;
  const bookDevigs = devigBooks(books);
  if (bookDevigs.length > 0) {
    const primary = [...bookDevigs].sort((a, b) => a.overround - b.overround)[0]; // 水位最低 = 最锐参考家
    const consensus = consensusProbs(bookDevigs, params.bookWeights)!;
    market = {
      rawOdds: primary.rawOdds,
      overround: primary.overround,
      shinZ: primary.shinZ,
      devigged: consensus.probs,
      books: bookDevigs.map(({ indicative: _i, ...rest }) => rest),
    };
    for (const bd of bookDevigs) {
      trace.push(
        `「${bd.bookmaker}」去水（Shin 1993）：水位 ${(bd.overround * 100).toFixed(2)}%，z=${bd.shinZ.toFixed(4)}，` +
          `公平概率 主${fmtPct(bd.devigged.home)}/平${fmtPct(bd.devigged.draw)}/客${fmtPct(bd.devigged.away)}` +
          (bd.indicative ? "（参考盘）" : ""),
      );
    }
    if (bookDevigs.length > 1) {
      const w = consensus.detail
        .map((d) => `${d.bookmaker}×${d.weight.toFixed(2)}${d.outlier ? "(离群降权)" : ""}`)
        .join("、");
      trace.push(
        `市场加权共识（因子权重：${w}）：` +
          `主${fmtPct(consensus.probs.home)}/平${fmtPct(consensus.probs.draw)}/客${fmtPct(consensus.probs.away)}`,
      );
    }
  } else {
    trace.push("无 1X2 盘口数据，市场模型缺席");
  }

  // 大小球去水（供市场反推与价值计算）：取最接近 2.5、水位最低的一家
  const ouMain = pickMainOu(books);
  let pOverDevigged: number | null = null;
  if (ouMain) {
    pOverDevigged = twoWayDevig(ouMain.over, ouMain.under);
    trace.push(`大小 ${ouMain.line} 盘去水（power 法）：P(大球)=${fmtPct(pOverDevigged)}`);
  }

  // ---------- 2. 公允概率源：AF 蒸馏预测（主）+ 市场共识（对照/兜底） ----------
  // 已彻底移除自建统计建模（Dixon-Coles 拟合 / Elo / xG 建模 / 历史训练）。
  // AF 用全量数据库蒸馏，概率优于任何自建模型；我们只做 AF 不提供的派生（比分矩阵 → 亚盘/大小球）。
  const afp = bundle.afPrediction ?? null;
  const afProbs = afp ? { home: afp.home, draw: afp.draw, away: afp.away } : null;
  let fallbackLevel: FallbackLevel;
  let ensembleProbs: ThreeWay;
  const ensWeights = { market: 0, dc: 0, elo: 0 };
  let afModel: EngineOutput["afModel"] = null;

  if (afProbs) {
    if (market) {
      const pool = logOpinionPool([
        { probs: afProbs, weight: params.afWeight },
        { probs: market.devigged, weight: 1 - params.afWeight },
      ]);
      ensembleProbs = pool.probs;
      ensWeights.market = pool.effectiveWeights[1];
      afModel = { probs: afProbs, expGoalsHome: afp!.expGoalsHome, expGoalsAway: afp!.expGoalsAway, advice: afp!.advice, weight: pool.effectiveWeights[0] };
    } else {
      ensembleProbs = afProbs;
      afModel = { probs: afProbs, expGoalsHome: afp!.expGoalsHome, expGoalsAway: afp!.expGoalsAway, advice: afp!.advice, weight: 1 };
    }
    fallbackLevel = 1;
    trace.push(
      `公允概率 = AF 蒸馏预测（权重${afModel.weight.toFixed(2)}）` +
        (market ? ` + 市场共识对照（${ensWeights.market.toFixed(2)}）` : "（无盘口，纯 AF）") +
        `：主${fmtPct(ensembleProbs.home)}/平${fmtPct(ensembleProbs.draw)}/客${fmtPct(ensembleProbs.away)}` +
        (afp!.advice ? `；AF 建议「${afp!.advice}」（仅参考）` : ""),
    );
  } else if (market) {
    ensembleProbs = market.devigged;
    ensWeights.market = 1;
    fallbackLevel = 3;
    trace.push(`无 AF 预测，公允概率回落市场共识：主${fmtPct(ensembleProbs.home)}/平${fmtPct(ensembleProbs.draw)}/客${fmtPct(ensembleProbs.away)}`);
  } else {
    ensembleProbs = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
    fallbackLevel = 4;
    trace.push("既无 AF 预测也无盘口，无法给出公允概率（等级 4）");
  }

  // ---------- 3. 期望进球 → 比分矩阵（亚盘/大小球/波胆派生的根基；AF 不提供矩阵，由我们泊松展开） ----------
  let lambda = 0;
  let mu = 0;
  const rho = params.rho;
  let matrixNote = "";
  const afExpValid = !!afp && afp.expGoalsHome !== null && afp.expGoalsAway !== null && afp.expGoalsHome > 0 && afp.expGoalsAway > 0;
  if (afExpValid) {
    lambda = afp!.expGoalsHome!;
    mu = afp!.expGoalsAway!;
    matrixNote = "AF 预测期望进球";
  } else if (market || pOverDevigged !== null) {
    const inv = marketInversion(ensembleProbs, pOverDevigged, ouMain?.line ?? 2.5, rho);
    lambda = inv.lambda;
    mu = inv.mu;
    matrixNote = `市场反推（${inv.note}）`;
  }

  // 情境修正（伤停/天气）——基于真实因子的确定性调整，非统计建模
  let adjustments: EngineOutput["adjustments"] = [];
  if ((lambda > 0 || mu > 0) && params.adjustmentsEnabled) {
    const adj = computeAdjustments({ injuries: bundle.injuries, weather: bundle.weather, neutralVenue: match.neutralVenue });
    adjustments = adj.adjustments.filter((a) => a.lambdaFactor !== 1 || a.muFactor !== 1 || !adj.gammaNeutral);
    lambda *= adj.lambdaFactor;
    mu *= adj.muFactor;
    for (const a of adjustments) trace.push(`情境修正：${a.reason}`);
  }
  lambda = Math.min(6, Math.max(0.05, lambda));
  mu = Math.min(6, Math.max(0.05, mu));

  let baseMatrix: number[][] | null = null;
  let dcProbs: ThreeWay | null = null;
  if (matrixNote) {
    baseMatrix = dcScoreMatrix(lambda, mu, rho);
    dcProbs = matrixToThreeWay(baseMatrix);
    trace.push(`比分矩阵（泊松，源：${matrixNote}）：λ=${lambda.toFixed(3)}，μ=${mu.toFixed(3)}，ρ=${rho.toFixed(3)}`);
  }
  const elo: EngineOutput["elo"] = null; // Elo 模型已移除

  // ---------- 6. 最终比分矩阵与衍生市场 ----------
  const finalMatrix = baseMatrix ? rescaleMatrixTo1x2(baseMatrix, ensembleProbs) : null;
  if (baseMatrix) trace.push("比分矩阵已整体重标定，使 1X2 边际与集成概率一致");

  const bestOuLines = bestOu(books);
  const bestAhLines = bestAh(books);
  const ouLines = bestOuLines.length ? bestOuLines.map((o) => o.line) : [2.5];
  const ouOut: EngineOutput["markets"]["ou"] = [];
  if (finalMatrix) {
    for (const line of [...new Set(ouLines)]) {
      const p = ouProbs(finalMatrix, line);
      ouOut.push({ line, over: p.over, under: p.under });
    }
  }
  const ahOut: EngineOutput["markets"]["ah"] = [];
  if (finalMatrix && bestAhLines.length) {
    for (const ah of bestAhLines) {
      const homeCover = ahHomeCover(finalMatrix, ah.line);
      ahOut.push({ line: ah.line, homeCover, awayCover: 1 - homeCover });
    }
  }

  // ---------- 7. 价值检测 + Kelly（一律用跨家最优价：真实可成交口径） ----------
  const value: EngineOutput["value"] = [];
  const best1x2 = bestOneXTwo(books);
  if (best1x2) {
    for (const sel of ["home", "draw", "away"] as const) {
      const p = ensembleProbs[sel];
      const { odds, bookmaker } = best1x2[sel];
      const ev = expectedValue(p, odds);
      value.push({
        market: "1x2",
        selection: sel,
        line: null,
        odds,
        bookmaker,
        modelProb: p,
        ev,
        kelly: kellyStake(p, odds, params.kellyFraction, params.kellyCap),
      });
    }
  }
  if (finalMatrix) {
    for (const ou of bestOuLines) {
      const p = ouProbs(finalMatrix, ou.line);
      for (const side of ["over", "under"] as const) {
        const { odds, bookmaker } = ou[side];
        const ev = ouEv(finalMatrix, ou.line, side, odds);
        value.push({
          market: "ou",
          selection: side,
          line: ou.line,
          odds,
          bookmaker,
          modelProb: side === "over" ? p.over : p.under,
          ev,
          kelly: kellyStake(side === "over" ? p.over : p.under, odds, params.kellyFraction, params.kellyCap),
        });
      }
    }
    for (const ah of bestAhLines) {
      const homeCover = ahHomeCover(finalMatrix, ah.line);
      for (const side of ["home", "away"] as const) {
        const { odds, bookmaker } = ah[side];
        const ev = ahEv(finalMatrix, ah.line, side, odds);
        const prob = side === "home" ? homeCover : 1 - homeCover;
        value.push({
          market: "ah",
          selection: side,
          line: ah.line,
          odds,
          bookmaker,
          modelProb: prob,
          ev,
          kelly: kellyStake(prob, odds, params.kellyFraction, params.kellyCap),
        });
      }
    }
  }
  const valuable = value.filter((v) => v.ev >= params.evThreshold);
  trace.push(
    value.length
      ? `价值扫描：${value.length} 个可评估点位，${valuable.length} 个 EV≥${fmtPct(params.evThreshold)}`
      : "无盘口赔率，跳过价值扫描",
  );

  // ---------- 7c. 价差监测：锐价真值锚 + 各家滞后偏离 + 市场失效指数 ----------
  // 第一性原理（玩家动线第④步）："这个价相对真值是贵还是便宜、哪家在让利"。
  // 硬庄/锐价单独去水做真值锚（赔率本身是最强预测模型），各家对锚的正偏离 = 滞后让利方向。
  let spread: EngineOutput["spread"] = null;
  if (bookDevigs.length > 0) {
    const sharpSet = new Set(params.sharpBooks);
    const sharps = bookDevigs.filter((b) => sharpSet.has(b.bookmaker) && !b.indicative);
    let anchorProbs: ThreeWay;
    let anchorSource: "sharp" | "consensus";
    let anchorBooks: string[];
    if (sharps.length > 0) {
      const acc = { home: 0, draw: 0, away: 0 };
      for (const s of sharps) {
        acc.home += s.devigged.home;
        acc.draw += s.devigged.draw;
        acc.away += s.devigged.away;
      }
      anchorProbs = { home: acc.home / sharps.length, draw: acc.draw / sharps.length, away: acc.away / sharps.length };
      anchorSource = "sharp";
      anchorBooks = sharps.map((s) => s.bookmaker);
    } else {
      anchorProbs = (market?.devigged ?? bookDevigs[0].devigged) as ThreeWay;
      anchorSource = "consensus";
      anchorBooks = bookDevigs.map((b) => b.bookmaker);
    }
    const deviations: NonNullable<EngineOutput["spread"]>["deviations"] = [];
    // 锚自身（锐价书商）不进偏离榜——锚对自己恒为微小负偏离（水位），是噪音不是信号
    for (const b of books) {
      if (!b.oneXTwo || b.indicative || (anchorSource === "sharp" && sharpSet.has(b.bookmaker ?? ""))) continue;
      for (const sel of ["home", "draw", "away"] as const) {
        const fairOdds = 1 / anchorProbs[sel];
        const deviationPct = b.oneXTwo[sel] / fairOdds - 1;
        if (Math.abs(deviationPct) >= 0.01) {
          deviations.push({ bookmaker: b.bookmaker ?? "未知来源", market: "1x2", line: null, selection: sel, odds: b.oneXTwo[sel], fairOdds, deviationPct });
        }
      }
    }
    // 两向市场（亚盘全线 + 大小球全线）：锐价逐线两向去水做锚——赌盘玩家第一视角是亚盘
    const sharpBooksRaw = books.filter((b) => sharpSet.has(b.bookmaker ?? "") && !b.indicative);
    const twoWayDeviations = (mkt: "ah" | "ou") => {
      // 锐价各线公允概率（同线多家锐价取平均）
      const fairByLine = new Map<number, number[]>();
      for (const b of sharpBooksRaw) {
        const lines = mkt === "ah" ? b.ah.map((a) => ({ line: a.line, x: a.home, y: a.away })) : b.ou.map((o) => ({ line: o.line, x: o.over, y: o.under }));
        for (const l of lines) fairByLine.set(l.line, [...(fairByLine.get(l.line) ?? []), twoWayDevig(l.x, l.y)]);
      }
      if (fairByLine.size === 0) return;
      const sides = (mkt === "ah" ? ["home", "away"] : ["over", "under"]) as ("home" | "away" | "over" | "under")[];
      for (const b of books) {
        if (b.indicative || sharpSet.has(b.bookmaker ?? "")) continue;
        const lines = mkt === "ah" ? b.ah : b.ou;
        for (const l of lines) {
          const samples = fairByLine.get(l.line);
          if (!samples) continue;
          const pFirst = samples.reduce((a, x) => a + x, 0) / samples.length; // P(主赢盘) / P(大球)
          for (const side of sides) {
            const isFirst = side === "home" || side === "over";
            const fairOdds = 1 / (isFirst ? pFirst : 1 - pFirst);
            const odds = (l as Record<string, number>)[side];
            const deviationPct = odds / fairOdds - 1;
            if (Math.abs(deviationPct) >= 0.01) {
              deviations.push({ bookmaker: b.bookmaker ?? "未知来源", market: mkt, line: l.line, selection: side as "home" | "draw" | "away" | "over" | "under", odds, fairOdds, deviationPct });
            }
          }
        }
      }
    };
    twoWayDeviations("ah");
    twoWayDeviations("ou");
    // 展示顺序：亚盘 → 大小球 → 胜平负（玩家优先级），各市场内按让利幅度降序、限量防刷屏
    const MKT_ORDER: Record<string, number> = { ah: 0, ou: 1, "1x2": 2 };
    const MKT_CAP: Record<string, number> = { ah: 5, ou: 4, "1x2": 4 };
    deviations.sort((a, b) => MKT_ORDER[a.market] - MKT_ORDER[b.market] || b.deviationPct - a.deviationPct);
    const counts: Record<string, number> = {};
    const top = deviations.filter((d) => (counts[d.market] = (counts[d.market] ?? 0) + 1) <= MKT_CAP[d.market]).slice(0, 12);
    const inefficiencyIndex = best1x2 ? 1 / best1x2.home.odds + 1 / best1x2.draw.odds + 1 / best1x2.away.odds : null;
    spread = { anchor: { source: anchorSource, books: anchorBooks, probs: anchorProbs }, deviations: top, inefficiencyIndex };
    const nBy = (m: string) => deviations.filter((d) => d.market === m).length;
    trace.push(
      `价差监测：真值锚=${anchorSource === "sharp" ? `锐价（${anchorBooks.join("、")}）` : "加权共识"}，` +
        `偏离≥1% 的报价 ${deviations.length} 项（亚盘 ${nBy("ah")} / 大小球 ${nBy("ou")} / 胜平负 ${nBy("1x2")}）` +
        (inefficiencyIndex !== null ? `，跨家组合隐含概率 ${fmtPct(inefficiencyIndex)}${inefficiencyIndex < 1 ? "（出现定价失效现象）" : ""}` : ""),
    );
  }

  // ---------- 7b. 比分市场对照：波胆赔率 power 去水 vs 模型比分分布 ----------
  let scoreMarket: EngineOutput["scoreMarket"] = [];
  const csBook = books.find((b) => (b.correctScores?.length ?? 0) >= 8);
  if (csBook?.correctScores && finalMatrix) {
    const list = csBook.correctScores;
    const marketProbs = powerDevig(list.map((c) => c.odds));
    scoreMarket = list
      .map((c, i) => {
        const m = c.score.match(/^(\d+):(\d+)$/);
        const modelProb = m ? (finalMatrix[Number(m[1])]?.[Number(m[2])] ?? 0) : 0;
        return { score: c.score, marketProb: marketProbs[i], modelProb, odds: c.odds, bookmaker: csBook.bookmaker ?? "未知来源" };
      })
      .sort((a, b) => b.marketProb - a.marketProb)
      .slice(0, 8);
    trace.push(
      `比分市场对照：「${csBook.bookmaker ?? "未知来源"}」波胆 ${list.length} 项 power 去水，` +
        `市场最热 ${scoreMarket[0].score}（${fmtPct(scoreMarket[0].marketProb)}），模型 ${fmtPct(scoreMarket[0].modelProb)}`,
    );
  }

  // ---------- 8. 生成 picks（亚盘优先：玩家第一视角是让球盘） ----------
  const picks: EngineOutput["picks"] = [];
  for (const mkt of ["ah", "1x2", "ou"] as const) {
    const candidates = value
      .filter((v) => v.market === mkt && v.ev >= params.evThreshold && v.modelProb >= params.minProbForPick)
      .sort((a, b) => b.ev - a.ev);
    const best = candidates[0];
    if (best) {
      picks.push({
        market: mkt,
        selection: best.selection,
        line: best.line,
        modelProb: best.modelProb,
        odds: best.odds,
        bookmaker: best.bookmaker,
        ev: best.ev,
        kelly: best.kelly,
        confidence: best.ev >= 0.08 && best.modelProb >= 0.45 ? "A" : best.ev >= 0.05 ? "B" : "C",
      });
    }
  }
  // 无盘口时：模型倾向明显才给出 1X2 观点（无价值口径，置信 C）
  if (picks.length === 0 && bookDevigs.length === 0 && fallbackLevel < 4) {
    const best = (["home", "draw", "away"] as const)
      .map((sel) => ({ sel, p: ensembleProbs[sel] }))
      .sort((a, b) => b.p - a.p)[0];
    if (best.p >= 0.45) {
      picks.push({
        market: "1x2",
        selection: best.sel,
        line: null,
        modelProb: best.p,
        odds: null,
        ev: null,
        kelly: null,
        confidence: "C",
      });
      trace.push("无盘口可比价，按模型倾向给出 1X2 观点（置信 C）");
    }
  }
  if (picks.length === 0) trace.push("所有选项均无足够价值，本场建议观望（不计入战绩分母）");

  const output: EngineOutput = {
    modelVersion: ENGINE_MODEL_VERSION,
    computedAt: bundle.computedAt,
    fallbackLevel,
    market,
    dixonColes:
      finalMatrix
        ? {
            lambda,
            mu,
            rho,
            gamma: 1,
            probs: dcProbs ?? ensembleProbs,
            scoreMatrix: finalMatrix,
            topScores: topScores(finalMatrix, 5),
          }
        : null,
    elo,
    adjustments,
    afModel,
    ensemble: {
      weights: ensWeights,
      probs: ensembleProbs,
    },
    markets: { ou: ouOut, ah: ahOut },
    scoreMarket,
    value,
    picks,
    oddsMovement: (bundle.oddsSeries ?? []).map((o) => ({
      capturedAt: o.capturedAt,
      oneXTwo: o.oneXTwo ?? null,
      bookmaker: o.bookmaker,
    })),
    spread,
    trace,
  };
  return engineOutputSchema.parse(output);
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
