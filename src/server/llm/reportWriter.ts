import { z } from "zod";
import { minAcceptableOdds } from "../engine/boundary";
import type { EngineOutput } from "../engine/types";
import { chatCompletion, LlmUnavailableError } from "./apiyi";
import { buildWhitelist, findViolations } from "./numberGuard";

/**
 * 投行风格研报生成：
 * 数字 100% 由代码模板渲染；LLM 只产出三段定性文字（核心论点/驱动因素/风险提示），
 * 经数字白名单校验（违规重试 ≤2 次），失败则降级为纯模板文案——发布流程永不被 LLM 阻塞。
 */

export interface MatchMeta {
  leagueName: string;
  homeName: string;
  awayName: string;
  kickoffAt: number;
  venue: string | null;
  round: string | null;
  neutral: boolean;
}

export interface SnapshotMeta {
  kind: string;
  kindLabel: string;
  source: string;
  fetchedAt: number;
  count: number;
}

export interface ReportContext {
  match: MatchMeta;
  engine: EngineOutput;
  version: number;
  /** 上一版集成概率（首版为 null），用于"较上版变化" */
  prevEnsemble: { home: number; draw: number; away: number } | null;
  snapshots: SnapshotMeta[];
  missingKinds: string[];
  /** 事实清单：伤停/近况/排名/天气/软信息等文字事实（数字白名单来源） */
  facts: string[];
  totalSnapshotCount: number;
  /** 最低可接受赔率安全垫（engine.boundaryMargin；缺省 1.02） */
  boundaryMargin?: number;
}

export const llmSectionsSchema = z.object({
  thesis: z.string().min(10),
  drivers: z.array(z.string().min(4)).min(2).max(6),
  risks: z.array(z.string().min(4)).min(1).max(4),
  /** 深度章节（写作模型产出，全部定性；旧版本数据无这些字段） */
  tactics: z.string().optional(),
  marketView: z.string().optional(),
  scenarios: z.array(z.string().min(4)).max(4).default([]),
});
export type LlmSections = z.infer<typeof llmSectionsSchema> & {
  generatedAtVersion: number;
  degraded: boolean;
};

const MARKET_LABEL: Record<string, string> = { "1x2": "胜平负", ou: "大小球", ah: "亚盘" };
const SEL_LABEL: Record<string, string> = {
  home: "主胜",
  draw: "平局",
  away: "客胜",
  over: "大球",
  under: "小球",
};

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
function pp(d: number): string {
  return `${(d * 100).toFixed(1)}个百分点`;
}
function fmtOdds(o: number | null | undefined): string {
  return o === null || o === undefined ? "—" : o.toFixed(2);
}
function fmtTime(t: number): string {
  return new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
export function selectionLabel(market: string, selection: string, line: number | null): string {
  if (market === "1x2") return SEL_LABEL[selection] ?? selection;
  if (market === "ou") return `${SEL_LABEL[selection] ?? selection} ${line ?? ""}`.trim();
  if (market === "ah") {
    const side = selection === "home" ? "主队" : "客队";
    const l = line ?? 0;
    return `${side}盘口 ${l > 0 ? `+${l}` : l}`;
  }
  return selection;
}

/** 评级：picks 最高置信 → 信心等级（A/B/C/观望，专业徽章口径，不用星级） */
export function ratingStars(engine: EngineOutput): { stars: string; verdict: string } {
  const best = engine.picks[0];
  if (!best) return { stars: "观望", verdict: "观望（无足够价值偏差）" };
  const conf = engine.picks.reduce((m, p) => (p.confidence < m ? p.confidence : m), "C" as string);
  const labels = engine.picks.map((p) => selectionLabel(p.market, p.selection, p.line)).join("、");
  return { stars: `评级 ${conf}`, verdict: `倾向：${labels}` };
}

/** 代码预生成的定性结论短语（供 LLM 引用措辞，自身不含敏感数字） */
export function qualitativePhrases(ctx: ReportContext): string[] {
  const e = ctx.engine;
  const phrases: string[] = [];
  const lvl = { 1: "完整历史拟合", 2: "简化矩估计", 3: "市场反推", 4: "纯市场参照" }[e.fallbackLevel];
  phrases.push(`本场模型运行于「${lvl}」档位`);
  if (e.market) {
    const diff = e.ensemble.probs.home - e.market.devigged.home;
    const dir = diff > 0.03 ? "明显高于" : diff > 0.01 ? "略高于" : diff < -0.03 ? "明显低于" : diff < -0.01 ? "略低于" : "基本贴合";
    phrases.push(`模型对主胜的评估${dir}市场去水定价`);
    if (e.market.books.length > 1) {
      phrases.push(`市场参照覆盖 ${e.market.books.length} 家盘口来源（${e.market.books.map((b) => b.bookmaker).join("、")}），共识取各家去水中位数`);
    }
  } else {
    phrases.push("本场缺乏盘口数据，结论基于纯模型概率，置信度相应下调");
  }
  const top = e.picks[0];
  if (top) {
    phrases.push(`最优价值点位于${MARKET_LABEL[top.market]}的「${selectionLabel(top.market, top.selection, top.line)}」方向`);
  } else {
    phrases.push("所有点位的期望值均不足以覆盖水位成本，结论为观望");
  }
  for (const a of e.adjustments) phrases.push(`情境修正已计入：${a.reason}`);
  if (ctx.match.neutral) phrases.push("本场为中立场地，模型未计入常规主场优势");
  if (e.oddsMovement.length >= 2) {
    const first = e.oddsMovement[0].oneXTwo;
    const last = e.oddsMovement[e.oddsMovement.length - 1].oneXTwo;
    if (first && last) {
      const d = last.home - first.home;
      if (Math.abs(d) > 0.07) phrases.push(`盘口自开盘以来出现${d < 0 ? "主队方向收缩（降赔）" : "主队方向松动（升赔）"}的可见异动`);
      else phrases.push("盘口自开盘以来保持平稳");
    }
  }
  if (ctx.prevEnsemble) {
    const d = e.ensemble.probs.home - ctx.prevEnsemble.home;
    if (Math.abs(d) >= 0.01) phrases.push(`较上一版报告，模型对主胜的评估${d > 0 ? "上调" : "下调"}`);
  }
  if (ctx.missingKinds.length > 0) phrases.push(`以下数据维度本场缺失：${ctx.missingKinds.join("、")}（已反映在置信度中）`);
  return phrases;
}

function fallbackSections(ctx: ReportContext): z.infer<typeof llmSectionsSchema> {
  const phrases = qualitativePhrases(ctx);
  return {
    thesis: phrases.slice(0, 2).join("；") + "。本段为系统模板文案（AI 措辞通道暂不可用，全部数字结论不受影响）。",
    drivers: phrases.slice(1, 5).map((p) => `${p}。`),
    risks: [
      "足球比赛单场方差极大，任何概率优势都不保证单场结果。",
      "临场阵容、天气与盘口变化可能在本版报告生成后继续演变，请以最新版本为准。",
    ],
    scenarios: [],
  };
}

export async function generateLlmSections(ctx: ReportContext): Promise<LlmSections> {
  const phrases = qualitativePhrases(ctx);
  // 白名单 = 事实清单 + 代码自产短语中的数字（如修正系数），LLM 引用它们不算编造
  const whitelist = buildWhitelist([...ctx.facts, ...phrases]);
  const fallback = fallbackSections(ctx);
  const system = [
    "你是一家体育数据研究机构的首席分析师，以投行卖方研报的克制、专业语气写作，简体中文。",
    "你将收到：比赛背景、由确定性数学模型计算完成的结论短语、以及事实清单。",
    "你的任务只是为指定字段撰写定性文字。【铁律】严禁输出任何具体数字、百分比、赔率、比分、积分（事实清单中原样出现过的数字除外）；",
    "所有数字均由系统排版呈现，你只用定性语言（如“明显占优”“略高于市场预期”“价值有限”）。",
    "输出 JSON：",
    `{"thesis": "核心论点（2-3句）", "drivers": ["关键驱动因素…3-5条"], "risks": ["风险提示…2-3条"],`,
    `"tactics": "战术对位分析（两队风格/攻防形态/对位优劣势，3-4句，纯定性）",`,
    `"marketView": "市场叙事（盘口为何如此开价、模型与市场共识的分歧方向及可能原因，2-3句）",`,
    `"scenarios": ["情景推演…1-3条（如关键人员变动确认、天气恶化等情形下结论将如何定性变化）"]}`,
  ].join("\n");
  const user = [
    `【比赛】${ctx.match.leagueName} ${ctx.match.round ?? ""}：${ctx.match.homeName}（主） vs ${ctx.match.awayName}（客）`,
    `开球：${fmtTime(ctx.match.kickoffAt)}${ctx.match.neutral ? "（中立场）" : ""}`,
    "",
    "【模型结论短语（请以此为基础措辞，不得自创数字）】",
    ...phrases.map((p) => `- ${p}`),
    "",
    "【事实清单】",
    ...ctx.facts.map((f) => `- ${f}`),
  ].join("\n");

  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw: string;
    try {
      raw = await chatCompletion({
        system,
        user: user + feedback,
        json: true,
        maxTokens: 2600,
        task: "writing",
        mock: JSON.stringify(fallback),
      });
    } catch (e) {
      if (e instanceof LlmUnavailableError) {
        return { ...fallback, generatedAtVersion: ctx.version, degraded: true };
      }
      throw e;
    }
    try {
      const parsed = llmSectionsSchema.parse(JSON.parse(raw));
      const all = [parsed.thesis, ...parsed.drivers, ...parsed.risks, parsed.tactics ?? "", parsed.marketView ?? "", ...parsed.scenarios].join("\n");
      const violations = findViolations(all, whitelist);
      if (violations.length === 0) {
        return { ...parsed, generatedAtVersion: ctx.version, degraded: false };
      }
      feedback = `\n\n【重写要求】你上一稿出现了未授权数字：${[...new Set(violations)].join("、")}。删除所有此类数字，用定性表述替代，重新输出 JSON。`;
    } catch {
      feedback = "\n\n【重写要求】上一稿不是合法 JSON 或字段不全，请严格按要求输出 JSON。";
    }
  }
  return { ...fallback, generatedAtVersion: ctx.version, degraded: true };
}

/** 规范化研报 markdown（哈希与导出用的权威文本工件；页面另有富组件渲染） */
export function renderReportMd(ctx: ReportContext, sections: z.infer<typeof llmSectionsSchema>): string {
  const e = ctx.engine;
  const m = ctx.match;
  const { stars, verdict } = ratingStars(e);
  const L: string[] = [];
  L.push(`# ${m.leagueName}${m.round ? ` ${m.round}` : ""}：${m.homeName} vs ${m.awayName} · 赛前量化研报`);
  L.push("");
  L.push(`> ${stars} · ${verdict}`);
  L.push(`> 第 ${ctx.version} 版 · 数据截至 ${fmtTime(e.computedAt)} · 开球 ${fmtTime(m.kickoffAt)}${m.neutral ? " · 中立场" : ""}`);
  L.push(`> 本报告为实时研报：赛前将随盘口/阵容/天气等数据持续重算改版，请以最新版本为准。`);
  L.push("");
  L.push("## 一、摘要");
  L.push("");
  L.push(`- 集成概率：主胜 **${pct(e.ensemble.probs.home)}** / 平局 **${pct(e.ensemble.probs.draw)}** / 客胜 **${pct(e.ensemble.probs.away)}**`);
  if (e.market) {
    const label = e.market.books.length > 1 ? `市场共识（${e.market.books.length} 家 Shin 去水中位数）` : "市场去水（Shin）";
    L.push(
      `- ${label}：主 ${pct(e.market.devigged.home)} / 平 ${pct(e.market.devigged.draw)} / 客 ${pct(e.market.devigged.away)}（主参考家水位 ${pct(e.market.overround)}）`,
    );
  }
  if (e.market && e.market.books.length > 0) {
    L.push("");
    L.push("| 盘口来源 | 主胜 | 平局 | 客胜 | 水位 | 去水主胜 |");
    L.push("|---|---|---|---|---|---|");
    for (const b of e.market.books) {
      L.push(
        `| ${b.bookmaker} | ${fmtOdds(b.rawOdds.home)} | ${fmtOdds(b.rawOdds.draw)} | ${fmtOdds(b.rawOdds.away)} | ${pct(b.overround)} | ${pct(b.devigged.home)} |`,
      );
    }
    L.push("");
  }
  if (e.picks.length > 0) {
    L.push(`- 赛前观点：`);
    for (const p of e.picks) {
      const boundary = minAcceptableOdds(p.modelProb, ctx.boundaryMargin ?? 1.02);
      L.push(
        `  - ${MARKET_LABEL[p.market]}「${selectionLabel(p.market, p.selection, p.line)}」` +
          `模型概率 ${pct(p.modelProb)}${p.odds ? `，参考赔率 ${fmtOdds(p.odds)}${p.bookmaker ? `（${p.bookmaker}）` : ""}` : ""}` +
          `${boundary > 0 ? `，**最低可接受赔率 ${fmtOdds(boundary)}**` : ""}${p.ev !== null ? `，EV ${pct(p.ev)}` : ""}` +
          `${p.kelly ? `，模拟单位（¼ Kelly 风险刻度）${pct(p.kelly)}` : ""}，置信 ${p.confidence}`,
      );
    }
    L.push(
      `- 最低可接受赔率是本观点的价格边界：你看到的实际价格低于该值时，本观点即失去参考价值（开赛锁定时若收盘价低于边界，该观点按观望处理、不计入战绩）。`,
    );
  } else {
    L.push(`- 赛前观点：**观望**——所有点位期望值不足以覆盖水位成本（观望场次不计入战绩分母）。`);
  }
  L.push("");
  L.push("## 二、核心论点");
  L.push("");
  L.push(sections.thesis);
  L.push("");
  L.push("## 三、关键驱动因素");
  L.push("");
  for (const d of sections.drivers) L.push(`- ${d}`);
  L.push("");
  if (sections.tactics) {
    L.push("### 战术对位");
    L.push("");
    L.push(sections.tactics);
    L.push("");
  }
  if (sections.marketView) {
    L.push("### 市场叙事");
    L.push("");
    L.push(sections.marketView);
    L.push("");
  }
  L.push("## 四、模型结果");
  L.push("");
  L.push("| 信息源 | 主胜 | 平局 | 客胜 | 集成权重 |");
  L.push("|---|---|---|---|---|");
  if (e.market) L.push(`| 市场（Shin 去水） | ${pct(e.market.devigged.home)} | ${pct(e.market.devigged.draw)} | ${pct(e.market.devigged.away)} | ${pct(e.ensemble.weights.market)} |`);
  if (e.dixonColes) L.push(`| Dixon-Coles 双泊松 | ${pct(e.dixonColes.probs.home)} | ${pct(e.dixonColes.probs.draw)} | ${pct(e.dixonColes.probs.away)} | ${pct(e.ensemble.weights.dc)} |`);
  if (e.elo) L.push(`| 进球差调整 Elo | ${pct(e.elo.probs.home)} | ${pct(e.elo.probs.draw)} | ${pct(e.elo.probs.away)} | ${pct(e.ensemble.weights.elo)} |`);
  L.push(`| **集成（对数意见池）** | **${pct(e.ensemble.probs.home)}** | **${pct(e.ensemble.probs.draw)}** | **${pct(e.ensemble.probs.away)}** | — |`);
  L.push("");
  if (e.dixonColes) {
    L.push(`λ（主队期望进球）= ${e.dixonColes.lambda.toFixed(3)}，μ（客队期望进球）= ${e.dixonColes.mu.toFixed(3)}，ρ = ${e.dixonColes.rho.toFixed(3)}，γ = ${e.dixonColes.gamma.toFixed(3)}`);
    L.push("");
    L.push("**最可能比分**：" + e.dixonColes.topScores.map((s) => `${s.score}（${pct(s.prob)}）`).join("、"));
    L.push("");
  }
  if (e.elo) {
    L.push(`**Elo**：${m.homeName} ${e.elo.home.toFixed(0)} vs ${m.awayName} ${e.elo.away.toFixed(0)}（含场地因素差 ${e.elo.diff.toFixed(0)}）`);
    L.push("");
  }
  if (e.markets.ou.length > 0 || e.markets.ah.length > 0) {
    L.push("## 五、衍生市场");
    L.push("");
    if (e.markets.ou.length > 0) {
      L.push("| 大小球盘 | 大球 | 小球 |");
      L.push("|---|---|---|");
      for (const ou of e.markets.ou) L.push(`| ${ou.line} | ${pct(ou.over)} | ${pct(ou.under)} |`);
      L.push("");
    }
    if (e.markets.ah.length > 0) {
      L.push("| 亚盘（主队让球） | 主队赢盘 | 客队赢盘 |");
      L.push("|---|---|---|");
      for (const ah of e.markets.ah) L.push(`| ${ah.line > 0 ? `+${ah.line}` : ah.line} | ${pct(ah.homeCover)} | ${pct(ah.awayCover)} |`);
      L.push("");
    }
  }
  if (e.scoreMarket.length > 0) {
    L.push("### 比分市场对照（波胆去水 vs 模型分布）");
    L.push("");
    L.push("| 比分 | 市场赔率 | 市场概率 | 模型概率 | 分歧 |");
    L.push("|---|---|---|---|---|");
    for (const s of e.scoreMarket) {
      const diff = s.modelProb - s.marketProb;
      L.push(`| ${s.score} | ${fmtOdds(s.odds)} | ${pct(s.marketProb)} | ${pct(s.modelProb)} | ${diff >= 0 ? "+" : ""}${pct(diff)} |`);
    }
    L.push("");
  }
  const valuable = e.value.filter((v) => v.ev >= 0.0);
  if (e.value.length > 0) {
    L.push("## 六、价值扫描与模拟单位（¼ Kelly 风险刻度，上限 5%）");
    L.push("");
    L.push("| 玩法 | 点位 | 最优赔率 | 出处 | 模型概率 | 期望值 EV | 模拟单位 |");
    L.push("|---|---|---|---|---|---|---|");
    for (const v of [...e.value].sort((a, b) => b.ev - a.ev).slice(0, 8)) {
      L.push(
        `| ${MARKET_LABEL[v.market]} | ${selectionLabel(v.market, v.selection, v.line)} | ${fmtOdds(v.odds)} | ${v.bookmaker ?? "—"} | ${pct(v.modelProb)} | ${v.ev >= 0 ? "+" : ""}${pct(v.ev)} | ${v.kelly > 0 ? pct(v.kelly) : "—"} |`,
      );
    }
    L.push("");
    if (valuable.length === 0) L.push("*全部点位 EV 为负——市场定价充分，本场观望。*");
    L.push("");
  }
  if (e.oddsMovement.length >= 2) {
    L.push("## 七、盘口异动（1X2）");
    L.push("");
    L.push("| 采集时间 | 来源 | 主胜 | 平局 | 客胜 |");
    L.push("|---|---|---|---|---|");
    for (const o of e.oddsMovement.slice(-10)) {
      if (o.oneXTwo) L.push(`| ${fmtTime(o.capturedAt)} | ${o.bookmaker ?? "—"} | ${fmtOdds(o.oneXTwo.home)} | ${fmtOdds(o.oneXTwo.draw)} | ${fmtOdds(o.oneXTwo.away)} |`);
    }
    L.push("");
  }
  L.push("## 八、数据基础与完备度");
  L.push("");
  L.push(`本场累计采集 **${ctx.totalSnapshotCount}** 份数据快照，覆盖 **${ctx.snapshots.length}** 个维度${ctx.missingKinds.length ? `，缺失：${ctx.missingKinds.join("、")}` : "，全维度齐备"}。`);
  L.push("");
  L.push("| 维度 | 来源 | 采集次数 | 最近采集 |");
  L.push("|---|---|---|---|");
  for (const s of ctx.snapshots) L.push(`| ${s.kindLabel} | ${s.source} | ${s.count} | ${fmtTime(s.fetchedAt)} |`);
  L.push("");
  L.push("## 九、风险提示");
  L.push("");
  if (sections.scenarios.length > 0) {
    L.push("### 情景推演");
    L.push("");
    for (const s of sections.scenarios) L.push(`- ${s}`);
    L.push("");
  }
  for (const r of sections.risks) L.push(`- ${r}`);
  L.push("- 收盘前盘口仍可能显著移动；本平台报告将持续改版，以开赛前最后一版为战绩结算口径。");
  L.push(
    "- 本报告全部概率与结算均为 **90 分钟常规时间口径**（不含加时与点球）；赔率参照来自多来源（官方 CSV / 竞彩 / Polymarket / AI 检索多家），价值口径取各方向跨家最优价，不同渠道实际成交价格可能不同。",
  );
  L.push("");
  L.push("## 十、计算过程（审计轨迹）");
  L.push("");
  for (const t of e.trace) L.push(`- ${t}`);
  L.push("");
  L.push("## 方法论与文献");
  L.push("");
  L.push("- Dixon & Coles (1997). *Modelling Association Football Scores and Inefficiencies in the Football Betting Market.* JRSS Series C 46(2).");
  L.push("- Hvattum & Arntzen (2010). *Using ELO ratings for match result prediction in association football.* International Journal of Forecasting 26(3).");
  L.push("- Shin (1993). *Measuring the Incidence of Insider Trading in a Market for State-Contingent Claims.* Economic Journal 103(420)；Štrumbelj (2014). IJF 30(4).");
  L.push("- Wheatcroft (2020). *A profitable model for predicting the over/under market in football.* IJF 36(3)（射门质量评分）。");
  L.push("- Genest & Zidek (1986). *Combining Probability Distributions.* Statistical Science 1(1)（对数意见池）；Kelly (1956). BSTJ 35(4)（仓位）。");
  L.push("");
  L.push("---");
  L.push(
    `*免责声明：本报告由确定性量化模型生成、AI 仅参与文字措辞，引擎版本 ${e.modelVersion}。内容仅供研究参考，不构成任何投注建议；足球比赛具有高度不确定性，请理性看待概率、自负风险。*`,
  );
  return L.join("\n");
}
