/**
 * AI 分析报告:按设计稿五分区结构(盘口解读/状态与盘路/进球模型/人员情报/结论与风险)
 * 基于 panorama 真实数据的规则模板生成;后续可在 buildReport 外层接 LLM 润色。
 */
import { ahText, f2, ouText } from "@/lib/format";
import type { Panorama } from "../af/panorama";
import { formZh, predSummary, type PredSummary } from "./common";

export interface ReportSection {
  h: string;
  ps: string[];
}

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

export function buildReport(p: Panorama): { ps: PredSummary | null; secs: ReportSection[] } {
  const fx = p.fixture;
  const ps = predSummary(p.prediction, fx.home_id);
  const secs: ReportSection[] = [];

  // ── 盘口解读 ──
  const ps1: string[] = [];
  const ahS = p.odds.ah;
  if (ahS.length > 0) {
    const first = ahS[0];
    const last = ahS[ahS.length - 1];
    if (first.line !== last.line && first.line != null && last.line != null) {
      const dir = Math.abs(last.line) > Math.abs(first.line) ? "升" : "降";
      ps1.push(
        `亚盘由初盘 ${ahText(first.line)} ${dir}至 ${ahText(last.line)},临场水位 ${f2(last.h)} / ${f2(last.a)}。` +
          (dir === "升" ? "让球加深,市场对让球方的信心有所增强。" : "盘口回撤,市场对让球方的态度趋于谨慎。"),
      );
    } else if (last.line != null) {
      ps1.push(`亚盘自初盘维持 ${ahText(last.line)},临场水位 ${f2(last.h)} / ${f2(last.a)},市场对该盘口分歧不大。`);
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
      `大小球${lineTxt},大水 ${f2(last.h)} / 小水 ${f2(last.a)}。` +
        (last.h < last.a ? "大球一侧水位更低,市场倾向偏大。" : last.h > last.a ? "小球一侧水位更低,市场略偏小球。" : "两侧水位均衡,方向尚不明朗。"),
    );
  }
  if (ps1.length === 0) ps1.push("本场盘口快照仍在积累,开盘后将自动补全盘口解读。");
  secs.push({ h: "盘口解读", ps: ps1 });

  // ── 状态与盘路 ──
  const ps2: string[] = [];
  if (ps) {
    const fH = formZh(ps.formHome).join(" ");
    const fA = formZh(ps.formAway).join(" ");
    if (fH || fA) ps2.push(`${fx.home_name} 近 6 场:${fH || "—"};${fx.away_name} 近 6 场:${fA || "—"}。`);
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
    ps2.push(`近 ${h2h.length} 次交锋,${fx.home_name} 取胜 ${myWins} 次,大球(>2.5)出现 ${big} 次。`);
  }
  if (ps2.length === 0) ps2.push("两队近况与交锋数据积累中。");
  secs.push({ h: "状态与盘路", ps: ps2 });

  // ── 进球模型 ──
  const ps3: string[] = [];
  if (ps && (ps.goalsHome || ps.goalsAway)) {
    ps3.push(
      `模型给出的进球上限:主队 ${ps.goalsHome ?? "—"} / 客队 ${ps.goalsAway ?? "—"}` +
        (ps.uoText ? `,大小球建议「${ps.uoText}」。` : "。"),
    );
  }
  const att = ps?.comparison["攻击"];
  const def = ps?.comparison["防守"];
  if (att && (att.home || att.away)) ps3.push(`攻击端对比 主 ${att.home}% / 客 ${att.away}%;防守端对比 主 ${def?.home ?? "—"}% / 客 ${def?.away ?? "—"}%。`);
  if (ps3.length === 0) ps3.push("进球模型数据待预测快照就绪后生成。");
  secs.push({ h: "进球模型", ps: ps3 });

  // ── 人员情报 ──
  const intel = p.injuries.slice(0, 8).map((i) => {
    const side = Number(dig(i, "team", "id")) === fx.home_id ? fx.home_name : fx.away_name;
    return `${side}:${dig(i, "player", "name") ?? ""} · ${dig(i, "player", "reason") ?? "未注明"}(${dig(i, "player", "type") ?? ""})`;
  });
  secs.push({ h: "人员情报", ps: intel.length > 0 ? intel : ["暂无官方伤停通报;首发公布后自动更新。"] });

  // ── 结论与风险 ──
  const ps5: string[] = [];
  if (ps) {
    ps5.push(
      `综合盘口、状态与概率模型,本场倾向:${ps.advice}。胜平负概率 主 ${ps.pH}% / 平 ${ps.pD}% / 客 ${ps.pA}%` +
        (ps.winDraw ? ",领先方优势未过半,建议搭配平局保护。" : "。"),
    );
  } else {
    ps5.push("预测快照尚未就绪,结论将于开盘后生成。");
  }
  ps5.push("报告基于赛前数据快照生成;首发公布与临场资金可能改变盘口,请结合异动监控自行判断。");
  secs.push({ h: "结论与风险", ps: ps5 });

  return { ps, secs };
}
