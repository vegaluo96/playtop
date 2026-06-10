import {
  blendedGoals,
  chooseDcLevel,
  dcScoreMatrix,
  fitDixonColesMLE,
  fitShotWeights,
  marketInversion,
  matrixToThreeWay,
  momentEstimate,
  shotsCoverage,
  type DcParams,
} from "./dixonColes";
import { eloToProbs } from "./elo";
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
    const consensus = consensusProbs(bookDevigs)!;
    market = {
      rawOdds: primary.rawOdds,
      overround: primary.overround,
      shinZ: primary.shinZ,
      devigged: consensus,
      books: bookDevigs,
    };
    for (const bd of bookDevigs) {
      trace.push(
        `「${bd.bookmaker}」去水（Shin 1993）：水位 ${(bd.overround * 100).toFixed(2)}%，z=${bd.shinZ.toFixed(4)}，` +
          `公平概率 主${fmtPct(bd.devigged.home)}/平${fmtPct(bd.devigged.draw)}/客${fmtPct(bd.devigged.away)}`,
      );
    }
    if (bookDevigs.length > 1) {
      trace.push(
        `市场共识（${bookDevigs.length} 家逐项中位数归一）：` +
          `主${fmtPct(consensus.home)}/平${fmtPct(consensus.draw)}/客${fmtPct(consensus.away)}`,
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

  // ---------- 2. Dixon-Coles ----------
  let fallbackLevel: FallbackLevel;
  let dc: EngineOutput["dixonColes"] = null;
  let lambda = 0;
  let mu = 0;
  let rho = params.rho;
  let gamma = 1;
  let dcProbs: ThreeWay | null = null;
  let dcIsMarketDerived = false;

  const dcLevel = chooseDcLevel(bundle.leagueHistory, match.homeTeamId, match.awayTeamId);
  let fitted: DcParams | null = null;
  if (dcLevel === 1) {
    fitted = fitDixonColesMLE(bundle.leagueHistory, { xi: params.xi, refTime: bundle.computedAt, rhoInit: params.rho });
    fallbackLevel = 1;
    trace.push(
      `Dixon-Coles 完整 MLE：${bundle.leagueHistory.length} 场加权样本，` +
        `${fitted.iterations} 次迭代${fitted.converged ? "收敛" : "（达迭代上限）"}，logLik=${fitted.logLik.toFixed(1)}，` +
        `γ=${fitted.gamma.toFixed(3)}，ρ=${fitted.rho.toFixed(3)}`,
    );
    // 射门质量混合（Wheatcroft 2020）：进球噪声大，射门/射正更稳定；
    // α/β/γ 用混合响应 quasi-Poisson 重拟合，ρ 沿用纯进球 DC 的估计
    const coverage = shotsCoverage(bundle.leagueHistory);
    if (params.shotsBlendTheta > 0 && coverage >= 0.6) {
      const sw = fitShotWeights(bundle.leagueHistory);
      if (sw) {
        const blendFit = fitDixonColesMLE(bundle.leagueHistory, {
          xi: params.xi,
          refTime: bundle.computedAt,
          rhoInit: 0,
          freezeRho: true,
          goals: blendedGoals(params.shotsBlendTheta, sw),
        });
        fitted = { ...blendFit, rho: fitted.rho };
        trace.push(
          `射门质量混合（Wheatcroft 2020）：覆盖率 ${(coverage * 100).toFixed(0)}%，` +
            `OLS 标定 伪进球=${sw.c.toFixed(3)}+${sw.wShots.toFixed(3)}·射门+${sw.wSot.toFixed(3)}·射正（n=${sw.samples}），` +
            `θ=${params.shotsBlendTheta}，攻防/主场参数已按混合响应重拟合`,
        );
      }
    } else if (params.shotsBlendTheta > 0) {
      trace.push(`历史射门数据覆盖率 ${(coverage * 100).toFixed(0)}% 不足 60%，跳过射门质量混合`);
    }
  } else if (dcLevel === 2) {
    fitted = momentEstimate(bundle.leagueHistory, { xi: params.xi, refTime: bundle.computedAt, rhoInit: params.rho });
    fallbackLevel = 2;
    trace.push(`历史样本不足以稳定 MLE，Dixon-Coles 退化为矩估计（${bundle.leagueHistory.length} 场），γ=${fitted.gamma.toFixed(3)}`);
  } else {
    fitted = null;
    fallbackLevel = market ? 3 : 4;
  }

  if (fitted) {
    const hi = fitted.teamIndex.get(match.homeTeamId);
    const ai = fitted.teamIndex.get(match.awayTeamId);
    if (hi === undefined || ai === undefined) {
      trace.push("参赛队未出现在历史样本中，Dixon-Coles 退化为市场反推");
      fitted = null;
      fallbackLevel = market ? 3 : 4;
    } else {
      gamma = fitted.gamma;
      rho = fitted.rho;
      lambda = fitted.attack[hi] * fitted.defense[ai] * gamma;
      mu = fitted.attack[ai] * fitted.defense[hi];
    }
  }
  if (!fitted && fallbackLevel === 3 && market) {
    const inv = marketInversion(market.devigged, pOverDevigged, ouMain?.line ?? 2.5, params.rho);
    lambda = inv.lambda;
    mu = inv.mu;
    rho = params.rho;
    gamma = 1; // 市场价格已含主场优势
    dcIsMarketDerived = true;
    trace.push(`Dixon-Coles 市场反推：${inv.note}；λ=${lambda.toFixed(3)}，μ=${mu.toFixed(3)}`);
  }
  if (fallbackLevel === 4) {
    trace.push("既无足够历史也无盘口，无法构建比分分布（等级 4）");
  }

  // ---------- 3. 情境修正层 ----------
  let adjustments: EngineOutput["adjustments"] = [];
  if (fallbackLevel < 4) {
    if (params.adjustmentsEnabled) {
      const adj = computeAdjustments({
        injuries: bundle.injuries,
        weather: bundle.weather,
        neutralVenue: match.neutralVenue,
      });
      adjustments = adj.adjustments;
      lambda *= adj.lambdaFactor;
      mu *= adj.muFactor;
      if (adj.gammaNeutral && !dcIsMarketDerived && gamma > 0) {
        // 中立场：主场优势减半（γ → √γ），等效于 λ ÷ √γ
        lambda /= Math.sqrt(gamma);
        adjustments = [
          ...adjustments,
          { reason: "中立场地：主场优势减半（γ→√γ）", lambdaFactor: 1 / Math.sqrt(gamma), muFactor: 1 },
        ];
      }
      for (const a of adjustments) trace.push(`情境修正：${a.reason}`);
      if (adjustments.length === 0) trace.push("情境修正：无触发项");
    } else {
      trace.push("情境修正层已被管理员关闭");
    }
    lambda = Math.min(6, Math.max(0.05, lambda));
    mu = Math.min(6, Math.max(0.05, mu));
  }

  let baseMatrix: number[][] | null = null;
  if (fallbackLevel < 4) {
    baseMatrix = dcScoreMatrix(lambda, mu, rho);
    dcProbs = matrixToThreeWay(baseMatrix);
    trace.push(
      `比分分布：λ=${lambda.toFixed(3)}，μ=${mu.toFixed(3)}，ρ=${rho.toFixed(3)}；` +
        `DC 三向 主${fmtPct(dcProbs.home)}/平${fmtPct(dcProbs.draw)}/客${fmtPct(dcProbs.away)}`,
    );
  }

  // ---------- 4. Elo ----------
  let elo: EngineOutput["elo"] = null;
  if (bundle.elo && bundle.elo.home.matchesPlayed >= 10 && bundle.elo.away.matchesPlayed >= 10) {
    const homeAdv = match.neutralVenue ? 0 : params.homeAdvElo;
    const d = bundle.elo.home.rating + homeAdv - bundle.elo.away.rating;
    const probs = eloToProbs(d, params.eloCalib);
    elo = { home: bundle.elo.home.rating, away: bundle.elo.away.rating, diff: d, probs };
    trace.push(
      `Elo（Hvattum & Arntzen 2010）：主 ${bundle.elo.home.rating.toFixed(0)} vs 客 ${bundle.elo.away.rating.toFixed(0)}，` +
        `含主场分差 d=${d.toFixed(0)}，三向 主${fmtPct(probs.home)}/平${fmtPct(probs.draw)}/客${fmtPct(probs.away)}`,
    );
  } else {
    trace.push("Elo 样本不足（任一队 <10 场），该模型缺席");
  }

  // ---------- 5. 对数意见池集成 ----------
  // 市场反推得到的 DC 不是独立信息源，集成时其权重并入市场，避免重复计票
  const w = params.ensembleWeights;
  const members = [
    { probs: market?.devigged ?? null, weight: dcIsMarketDerived ? w.market + w.dc : w.market },
    { probs: dcIsMarketDerived ? null : dcProbs, weight: w.dc },
    { probs: elo?.probs ?? null, weight: w.elo },
  ];
  const pool = logOpinionPool(members);
  const ensembleProbs = pool.probs;
  trace.push(
    `对数意见池集成（市场${pool.effectiveWeights[0].toFixed(2)}/DC${pool.effectiveWeights[1].toFixed(2)}/Elo${pool.effectiveWeights[2].toFixed(2)}）：` +
      `主${fmtPct(ensembleProbs.home)}/平${fmtPct(ensembleProbs.draw)}/客${fmtPct(ensembleProbs.away)}`,
  );

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
      ? `价值扫描：${value.length} 个可下注选项，${valuable.length} 个 EV≥${fmtPct(params.evThreshold)}`
      : "无盘口赔率，跳过价值扫描",
  );

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

  // ---------- 8. 生成 picks ----------
  const picks: EngineOutput["picks"] = [];
  for (const mkt of ["1x2", "ou", "ah"] as const) {
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
      fallbackLevel < 4 && finalMatrix
        ? {
            lambda,
            mu,
            rho,
            gamma,
            probs: dcProbs ?? ensembleProbs,
            scoreMatrix: finalMatrix,
            topScores: topScores(finalMatrix, 5),
          }
        : null,
    elo,
    adjustments,
    ensemble: {
      weights: {
        market: pool.effectiveWeights[0],
        dc: pool.effectiveWeights[1],
        elo: pool.effectiveWeights[2],
      },
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
    trace,
  };
  return engineOutputSchema.parse(output);
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
