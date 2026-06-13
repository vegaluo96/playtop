/**
 * AI 概率报告:按设计稿五分区结构(指数解读/状态与盘路/进球模型/人员情报/概率摘要与风险)
 * 基于 panorama 真实数据的规则模板生成;后续可在 buildReport 外层接 LLM 润色。
 */
import { ahText, f2, ouText } from "@/lib/format";
import type { Panorama } from "../af/panorama";
import { formZh, predSummary, type PredSummary } from "./common";
import { nameZh } from "./names";
import { buildReportSignals, publicProbability, publicReportAdvice, type ReportSignals } from "./report-signals";

export interface ReportSection {
  h: string;
  ps: string[];
}

function hintOf(s: { line: number | null; h: number; a: number }[]) {
  return s.length > 0 ? { line: s[s.length - 1].line, h: s[s.length - 1].h, a: s[s.length - 1].a } : null;
}

export function buildReportSummary(p: Panorama): PredSummary | null {
  const fx = p.fixture;
  return predSummary(p.prediction, fx.home_id, {
    ah: hintOf(p.odds.ah),
    ou: hintOf(p.odds.ou),
    homeName: nameZh(fx.home_name),
    awayName: nameZh(fx.away_name),
  });
}

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

export function buildReport(p: Panorama, signals?: ReportSignals): { ps: PredSummary | null; secs: ReportSection[]; signals: ReportSignals } {
  const fx = p.fixture;
  const ps = buildReportSummary(p);
  const sig = signals ?? buildReportSignals(ps, p.odds);
  const prob = publicProbability(ps);
  const publicAdvice = publicReportAdvice(ps, sig);
  const secs: ReportSection[] = [];

  // ── 指数解读 ──
  const ps1: string[] = [];
  const ahS = p.odds.ah;
  if (ahS.length > 0) {
    const first = ahS[0];
    const last = ahS[ahS.length - 1];
    if (first.line !== last.line && first.line != null && last.line != null) {
      const dir = Math.abs(last.line) > Math.abs(first.line) ? "升" : "降";
      ps1.push(
        `让球指数由初始 ${ahText(first.line)} ${dir}至即时 ${ahText(last.line)},即时水位 ${f2(last.h)} / ${f2(last.a)}。` +
          (dir === "升" ? "让球加深,市场对让球方的信心有所增强。" : "指数回撤,市场对让球方的态度趋于谨慎。"),
      );
    } else if (last.line != null) {
      ps1.push(`让球指数即时维持 ${ahText(last.line)},即时水位 ${f2(last.h)} / ${f2(last.a)},市场对该指数分歧不大。`);
    }
  }
  const ouS = p.odds.ou;
  if (ouS.length > 0) {
    const first = ouS[0];
    const last = ouS[ouS.length - 1];
    const lineTxt =
      first.line !== last.line && first.line != null
        ? `由 ${ouText(first.line)} 调整至 ${ouText(last.line ?? 0)}`
        : `维持 ${ouText(last.line ?? 0)}`;
    ps1.push(
      `大小指数${lineTxt},大水 ${f2(last.h)} / 小水 ${f2(last.a)}。` +
        (last.h < last.a ? "大球一侧水位更低,市场倾向偏大。" : last.h > last.a ? "小球一侧水位更低,市场略偏小球。" : "两侧水位均衡,方向尚不明朗。"),
    );
  }
  if (ps1.length === 0) ps1.push("本场指数快照仍在积累,开盘后将自动补全指数解读。");
  ps1.push(
    `${sig.summary}。量化评分 AH ${sig.model.ahScore == null ? "暂无" : sig.model.ahScore} / OU ${sig.model.ouScore == null ? "暂无" : sig.model.ouScore};覆盖率 ${sig.model.coverage}%。`,
  );
  secs.push({ h: "指数解读", ps: ps1 });

  // ── 状态与盘路 ──
  const ps2: string[] = [];
  if (ps) {
    const fH = formZh(ps.formHome).join(" ");
    const fA = formZh(ps.formAway).join(" ");
    if (fH || fA) ps2.push(`${nameZh(fx.home_name)} 近 6 场:${fH || "—"};${nameZh(fx.away_name)} 近 6 场:${fA || "—"}。`);
  }
  const h2h = Array.isArray(dig(p.prediction, "h2h")) ? (dig(p.prediction, "h2h") as unknown[]) : [];
  if (h2h.length > 0) {
    let myWins = 0;
    let big = 0;
    for (const g of h2h) {
      const gh = Number(dig(g, "goals", "home"));
      const ga = Number(dig(g, "goals", "away"));
      const homeIsMe = Number(dig(g, "teams", "home", "id")) === fx.home_id;
      if ((homeIsMe && gh > ga) || (!homeIsMe && ga > gh)) myWins++;
      if (gh + ga > 2.5) big++;
    }
    ps2.push(`近 ${h2h.length} 次交锋,${nameZh(fx.home_name)} 取胜 ${myWins} 次,大球(>2.5)出现 ${big} 次。`);
  }
  if (ps2.length === 0) ps2.push("暂无官方近况与交锋数据。");
  secs.push({ h: "状态与盘路", ps: ps2 });

  // ── 进球模型 ──
  const ps3: string[] = [];
  if (ps && (ps.goalsHome || ps.goalsAway)) {
    ps3.push(
      `模型给出的进球上限:主队 ${ps.goalsHome ?? "—"} / 客队 ${ps.goalsAway ?? "—"}` +
        (ps.uoText ? `,大小方向「${ps.uoText}」。` : "。"),
    );
  }
  const att = ps?.comparison["攻击"];
  const def = ps?.comparison["防守"];
  if (att && (att.home || att.away)) ps3.push(`攻击端对比 主 ${att.home}% / 客 ${att.away}%;防守端对比 主 ${def?.home ?? "—"}% / 客 ${def?.away ?? "—"}%。`);
  if (ps3.length === 0) ps3.push("进球模型待概率快照就绪后生成。");
  ps3.push(`大小球方向:${sig.ou.text}${sig.ou.sources.length > 0 ? `;来源:${sig.ou.sources.join("、")}` : "。"}`);
  secs.push({ h: "进球模型", ps: ps3 });

  // ── 人员情报 ──
  const intel = p.injuries.slice(0, 8).map((i) => {
    const side = Number(dig(i, "team", "id")) === fx.home_id ? nameZh(fx.home_name) : nameZh(fx.away_name);
    return `${side}:${nameZh(String(dig(i, "player", "name") ?? ""), "player")} · ${dig(i, "player", "reason") ?? "未注明"}(${dig(i, "player", "type") ?? ""})`;
  });
  secs.push({ h: "人员情报", ps: intel.length > 0 ? intel : ["暂无伤停通报;首发公布后自动更新。"] });

  // ── 概率摘要与风险 ──
  const ps5: string[] = [];
  if (ps && prob.probReady) {
    ps5.push(
      `综合指数、状态与概率模型,本场概率摘要:${publicAdvice.advice ?? ps.advice}。胜平负概率 主 ${prob.pH}% / 平 ${prob.pD}% / 客 ${prob.pA}%` +
        (ps.winDraw ? ",领先方优势未过半,平局风险需要单独评估。" : "。"),
    );
    ps5.push(`亚盘方向:${sig.ah.text}${sig.ah.sources.length > 0 ? `;来源:${sig.ah.sources.join("、")}` : "。"}`);
    ps5.push(`预测市场:${sig.market.note}${sig.market.url ? `(${sig.market.url})` : ""}。`);
  } else if (ps && publicAdvice.advice) {
    ps5.push(`概率快照仍在积累,胜平负百分比暂不展示;当前仅按已归档指数、球队数据与可用模型信号输出:${publicAdvice.advice}。`);
    ps5.push(`亚盘方向:${sig.ah.text}${sig.ah.sources.length > 0 ? `;来源:${sig.ah.sources.join("、")}` : "。"}`);
    ps5.push(`预测市场:${sig.market.note}${sig.market.url ? `(${sig.market.url})` : ""}。`);
  } else {
    ps5.push("概率快照尚未就绪,报告摘要将于开盘后生成。");
  }
  ps5.push("报告基于赛前数据快照生成;开赛前随真实快照补齐更新,开赛后以最后一版赛前快照固化并用于回测。");
  secs.push({ h: "概率摘要与风险", ps: ps5 });

  return { ps, secs, signals: sig };
}
