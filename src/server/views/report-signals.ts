import { ahText, ouText } from "@/lib/format";
import type { SnapRow } from "../af/store";
import type { Panorama } from "../af/panorama";
import type { PredSummary } from "./common";

type AhSide = "home" | "away";
type OuSide = "over" | "under";

export interface PublicMarketSignal {
  status: "ok" | "missing" | "error" | "skipped";
  note: string;
  url?: string;
  source?: string;
  homeProb?: number | null;
  drawProb?: number | null;
  awayProb?: number | null;
  side?: AhSide | null;
  capturedAt?: number;
}

export interface DirectionSignal {
  status: "ok" | "open";
  text: string;
  side: AhSide | OuSide | null;
  line: number | null;
  sources: string[];
}

export interface ReportSignals {
  ah: DirectionSignal;
  ou: DirectionSignal;
  market: PublicMarketSignal;
  model: {
    method: string;
    coverage: number;
    ahScore: number | null;
    ouScore: number | null;
    inputs: { label: string; weight: number; status: "used" | "missing"; note: string }[];
  };
  summary: string;
}

export interface PublicComparison {
  comparison: Record<string, { home: number; away: number }>;
  comparisonReady: boolean;
}

function last(s: SnapRow[]): SnapRow | null {
  return s.length > 0 ? s[s.length - 1] : null;
}

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

function voteWinner(ps: PredSummary | null): AhSide | null {
  if (!ps?.winnerName) return null;
  return ps.winnerHome ? "home" : "away";
}

function ahSideFromLine(line: number | null): AhSide | null {
  if (line == null || line === 0) return null;
  return line > 0 ? "home" : "away";
}

function ahDirectionText(side: AhSide, line: number | null): string {
  if (line == null) return `${side === "home" ? "主队" : "客队"}方向 · 亚盘主线积累中`;
  if (line === 0) return `${side === "home" ? "主队" : "客队"}方向 · 平手`;
  const fav = ahSideFromLine(line);
  const role = fav === side ? `让${ahText(Math.abs(line))}` : `受让${ahText(Math.abs(line))}`;
  return `${side === "home" ? "主队" : "客队"}方向 · ${role}`;
}

function ouDirectionText(side: OuSide, line: number | null): string {
  if (line == null) return `${side === "over" ? "大球" : "小球"}方向 · 大小主线积累中`;
  const label = ouText(line);
  const unit = /[一二两三四五六七八九十半球/]/.test(label) ? "" : " 球";
  return `${side === "over" ? "大于" : "小于"} ${label}${unit}`;
}

function chooseSide<T extends string>(votes: { side: T; weight: number; source: string }[]): { side: T; sources: string[] } | null {
  if (votes.length === 0) return null;
  const scores = new Map<T, number>();
  for (const v of votes) scores.set(v.side, (scores.get(v.side) ?? 0) + v.weight);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < 0.75) return null;
  const side = ranked[0][0];
  return { side, sources: votes.filter((v) => v.side === side).map((v) => v.source) };
}

function parseUo(ps: PredSummary | null): OuSide | null {
  if (!ps?.uoText) return null;
  if (ps.uoText.includes("大于")) return "over";
  if (ps.uoText.includes("小于")) return "under";
  return null;
}

function goalsTotal(ps: PredSummary | null): number | null {
  const home = ps?.goalsHome == null ? NaN : Number(ps.goalsHome);
  const away = ps?.goalsAway == null ? NaN : Number(ps.goalsAway);
  return Number.isFinite(home) && Number.isFinite(away) ? home + away : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function comparisonEdge(ps: PredSummary | null): number | null {
  if (!ps) return null;
  const rows = Object.values(publicComparison(ps).comparison);
  if (rows.length === 0) return null;
  const avg = rows.reduce((n, r) => n + (r.home - r.away), 0) / rows.length;
  return clamp(avg / 100, -1, 1);
}

function goalsComparisonEdge(ps: PredSummary | null): number | null {
  const r = ps?.comparison["进球"];
  if (!r || (r.home <= 0 && r.away <= 0)) return null;
  return clamp((r.home - r.away) / 100, -1, 1);
}

function formEdge(ps: PredSummary | null): number | null {
  if (!ps) return null;
  const score = (form: string) =>
    form
      .split("")
      .slice(-6)
      .reduce((n, x) => n + (x === "W" ? 1 : x === "D" ? 0.35 : x === "L" ? -1 : 0), 0);
  const h = score(ps.formHome);
  const a = score(ps.formAway);
  if (h === 0 && a === 0) return null;
  return clamp((h - a) / 6, -1, 1);
}

function h2hEdges(p?: Panorama | null): { side: number | null; total: number | null } {
  if (!p) return { side: null, total: null };
  const rows = Array.isArray(dig(p.prediction, "h2h")) ? (dig(p.prediction, "h2h") as unknown[]) : [];
  if (rows.length === 0) return { side: null, total: null };
  let sideScore = 0;
  let totalGoals = 0;
  let counted = 0;
  for (const g of rows.slice(0, 10)) {
    const gh = Number(dig(g, "goals", "home"));
    const ga = Number(dig(g, "goals", "away"));
    if (!Number.isFinite(gh) || !Number.isFinite(ga)) continue;
    const homeIsFixtureHome = Number(dig(g, "teams", "home", "id")) === p.fixture.home_id;
    const fixtureHomeGoals = homeIsFixtureHome ? gh : ga;
    const fixtureAwayGoals = homeIsFixtureHome ? ga : gh;
    sideScore += Math.sign(fixtureHomeGoals - fixtureAwayGoals);
    totalGoals += gh + ga;
    counted++;
  }
  if (counted === 0) return { side: null, total: null };
  return { side: clamp(sideScore / counted, -1, 1), total: totalGoals / counted };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function teamSeasonEdges(p?: Panorama | null, ouLine?: number | null): { side: number | null; total: number | null } {
  const h = p?.deep?.statsHome;
  const a = p?.deep?.statsAway;
  if (!h || !a) return { side: null, total: null };
  const hPlayed = num(dig(h, "fixtures", "played", "total")) ?? 0;
  const aPlayed = num(dig(a, "fixtures", "played", "total")) ?? 0;
  const hWins = num(dig(h, "fixtures", "wins", "total")) ?? 0;
  const aWins = num(dig(a, "fixtures", "wins", "total")) ?? 0;
  const hDraws = num(dig(h, "fixtures", "draws", "total")) ?? 0;
  const aDraws = num(dig(a, "fixtures", "draws", "total")) ?? 0;
  const hFor = num(dig(h, "goals", "for", "average", "total"));
  const aFor = num(dig(a, "goals", "for", "average", "total"));
  const hAgainst = num(dig(h, "goals", "against", "average", "total"));
  const aAgainst = num(dig(a, "goals", "against", "average", "total"));
  const hPpg = hPlayed > 0 ? (hWins * 3 + hDraws) / hPlayed : null;
  const aPpg = aPlayed > 0 ? (aWins * 3 + aDraws) / aPlayed : null;
  const gd =
    hFor != null && hAgainst != null && aFor != null && aAgainst != null
      ? (hFor - hAgainst) - (aFor - aAgainst)
      : null;
  const side =
    hPpg == null && aPpg == null && gd == null
      ? null
      : clamp(((hPpg ?? 0) - (aPpg ?? 0)) / 2 + (gd ?? 0) / 4, -1, 1);
  const expected =
    hFor != null && hAgainst != null && aFor != null && aAgainst != null
      ? (hFor + aAgainst + aFor + hAgainst) / 2
      : null;
  const total = expected == null || ouLine == null ? null : clamp((expected - ouLine) / 3, -1, 1);
  return { side, total };
}

function injuryEdge(p?: Panorama | null): { side: number | null; total: number | null } {
  if (!p || p.injuries.length === 0) return { side: null, total: null };
  let home = 0;
  let away = 0;
  for (const item of p.injuries) {
    const id = Number(dig(item, "team", "id"));
    if (id === p.fixture.home_id) home++;
    if (id === p.fixture.away_id) away++;
  }
  if (home === 0 && away === 0) return { side: null, total: null };
  return {
    side: clamp((away - home) / 6, -1, 1),
    // 伤停只按数量轻量影响进球方向:伤停越多,进球模型越保守;不判断球员重要性。
    total: clamp(-(home + away) / 16, -1, 0),
  };
}

function euEdge(eu: SnapRow | null): number | null {
  if (!eu || eu.h <= 0 || eu.a <= 0) return null;
  const home = 1 / eu.h;
  const away = 1 / eu.a;
  return clamp((home - away) / Math.max(home + away, 0.0001), -1, 1);
}

function weightedScore(parts: { label: string; baseWeight: number; value: number | null; note: string }[]) {
  const used = parts.filter((p) => p.value != null);
  const total = used.reduce((n, p) => n + p.baseWeight, 0);
  const inputs = parts.map((p) => ({
    label: p.label,
    weight: p.value == null || total <= 0 ? 0 : Math.round((p.baseWeight / total) * 100),
    status: p.value == null ? "missing" as const : "used" as const,
    note: p.value == null ? "暂无真实来源" : p.note,
  }));
  if (total <= 0) return { score: null as number | null, coverage: 0, inputs };
  const score = used.reduce((n, p) => n + (p.value as number) * (p.baseWeight / total), 0);
  const coverage = Math.round(total * 100);
  return { score: Math.round(clamp(score, -1, 1) * 100), coverage, inputs };
}

function ahModelScore(ps: PredSummary | null, ah: SnapRow | null, eu: SnapRow | null, market: PublicMarketSignal, p?: Panorama | null) {
  const prob =
    hasUsableProbability(ps) && ps
      ? clamp(((ps.pH - ps.pA) / 100) * (1 - Math.min(ps.pD, 70) / 140), -1, 1)
      : null;
  const comp = comparisonEdge(ps);
  const form = formEdge(ps);
  const h2h = h2hEdges(p).side;
  const season = teamSeasonEdges(p).side;
  const injuries = injuryEdge(p).side;
  const odds =
    ah == null
      ? null
      : clamp(
          (ahSideFromLine(ah.line) === "home" ? 0.35 : ahSideFromLine(ah.line) === "away" ? -0.35 : 0) +
            (ah.h === ah.a ? 0 : ah.h < ah.a ? 0.25 : -0.25),
          -1,
          1,
        );
  const poly = market.status === "ok" && market.side ? (market.side === "home" ? 0.45 : -0.45) : null;
  return weightedScore([
    { label: "预测概率", baseWeight: 0.25, value: prob, note: "使用胜平负概率差与平局风险折减" },
    { label: "赛前亚盘指数", baseWeight: 0.18, value: odds, note: "使用开赛前主线与双侧水位" },
    { label: "赛前胜平负欧赔", baseWeight: 0.12, value: euEdge(eu), note: "使用欧赔隐含主客强弱差" },
    { label: "七维综合", baseWeight: 0.13, value: comp, note: "使用七维主客差" },
    { label: "球队赛季统计", baseWeight: 0.12, value: season, note: "使用赛季积分效率与场均净胜球" },
    { label: "近期状态", baseWeight: 0.07, value: form, note: "使用最近比赛结果" },
    { label: "历史交锋", baseWeight: 0.03, value: h2h, note: "使用近场胜负差" },
    { label: "伤停情报", baseWeight: 0.05, value: injuries, note: "使用伤停数量差,不估算球员权重" },
    { label: "Polymarket 预测市场", baseWeight: 0.05, value: poly, note: "使用公开市场 outcome 价格方向" },
  ]);
}

function ouModelScore(ps: PredSummary | null, ou: SnapRow | null, p?: Panorama | null) {
  const side = parseUo(ps);
  const goalSum = goalsTotal(ps);
  const h2h = h2hEdges(p);
  const season = teamSeasonEdges(p, ou?.line ?? null);
  const injuries = injuryEdge(p);
  const af =
    side == null && (goalSum == null || ou?.line == null)
      ? null
      : clamp((side === "over" ? 0.45 : side === "under" ? -0.45 : 0) + (goalSum != null && ou?.line != null ? (goalSum - ou.line) / 3 : 0), -1, 1);
  const odds =
    ou == null
      ? null
      : clamp(ou.h === ou.a ? 0 : ou.h < ou.a ? 0.45 : -0.45, -1, 1);
  return weightedScore([
    { label: "进球预测", baseWeight: 0.25, value: af, note: "使用 under_over 与进球模型" },
    { label: "赛前大小球指数", baseWeight: 0.25, value: odds, note: "使用开赛前大小球主线水位" },
    { label: "球队赛季进失球", baseWeight: 0.2, value: season.total, note: "使用两队赛季场均进失球估计总量" },
    { label: "历史交锋进球", baseWeight: 0.1, value: h2h.total != null && ou?.line != null ? clamp((h2h.total - ou.line) / 3, -1, 1) : null, note: "使用交锋场均总进球" },
    { label: "进球七维", baseWeight: 0.1, value: goalsComparisonEdge(ps), note: "使用进球维度主客差" },
    { label: "伤停对进球", baseWeight: 0.05, value: injuries.total, note: "仅按伤停数量轻量降权" },
    { label: "综合进球信号", baseWeight: 0.05, value: goalSum != null && ou?.line != null ? clamp((goalSum - ou.line) / 3, -1, 1) : null, note: "使用模型总进球与主线差" },
  ]);
}

export function hasUsableProbability(ps: PredSummary | null): boolean {
  if (!ps) return false;
  const probs = [ps.pH, ps.pD, ps.pA];
  if (probs.some((n) => n <= 0)) return false;
  const sum = probs.reduce((n, x) => n + x, 0);
  if (sum < 95 || sum > 105) return false;
  const spread = Math.max(...probs) - Math.min(...probs);
  if (spread <= 1) return false;
  return true;
}

export function publicProbability(ps: PredSummary | null): { pH: number; pD: number; pA: number; probReady: boolean } {
  const probReady = hasUsableProbability(ps);
  return {
    pH: probReady && ps ? ps.pH : 0,
    pD: probReady && ps ? ps.pD : 0,
    pA: probReady && ps ? ps.pA : 0,
    probReady,
  };
}

export function publicComparison(ps: PredSummary | null): PublicComparison {
  const comparison: PublicComparison["comparison"] = {};
  if (!ps) return { comparison, comparisonReady: false };
  for (const [label, c] of Object.entries(ps.comparison)) {
    const home = Number(c.home) || 0;
    const away = Number(c.away) || 0;
    if (home > 0 || away > 0) comparison[label] = { home, away };
  }
  return { comparison, comparisonReady: Object.keys(comparison).length > 0 };
}

export function publicReportAdvice(ps: PredSummary | null, signals: ReportSignals): { advice: string | null; summaryReady: boolean } {
  if (!ps) return { advice: null, summaryReady: false };
  if (signals.ah.status === "open" && signals.ou.status === "open") return { advice: null, summaryReady: false };
  const parts = [
    signals.ah.status === "ok" ? `亚盘:${signals.ah.text}` : null,
    signals.ou.status === "ok" ? `大小:${signals.ou.text}` : null,
  ].filter(Boolean);
  const prefix = hasUsableProbability(ps) ? "综合方向" : "赛前指数方向";
  return { advice: `${prefix}:${parts.join(";")}`, summaryReady: true };
}

export function buildReportSignals(
  ps: PredSummary | null,
  odds: { ah: SnapRow[]; ou: SnapRow[]; eu?: SnapRow[] },
  market: PublicMarketSignal = { status: "skipped", note: "未请求外部预测市场" },
  panorama?: Panorama | null,
): ReportSignals {
  const ah = last(odds.ah);
  const ou = last(odds.ou);
  const eu = last(odds.eu ?? []);
  const ahVotes: { side: AhSide; weight: number; source: string }[] = [];
  const winnerSide = voteWinner(ps);
  if (winnerSide) ahVotes.push({ side: winnerSide, weight: ps?.derived ? 1 : 2, source: ps?.derived ? "指数派生胜平负方向" : "预测模型方向" });
  if (hasUsableProbability(ps) && ps) {
    if (Math.abs(ps.pH - ps.pA) >= 6) ahVotes.push({ side: ps.pH > ps.pA ? "home" : "away", weight: 1, source: "胜平负概率差" });
  }
  const lineSide = ahSideFromLine(ah?.line ?? null);
  if (lineSide) ahVotes.push({ side: lineSide, weight: 0.75, source: "赛前亚盘主线" });
  if (ah && ah.h !== ah.a) ahVotes.push({ side: ah.h < ah.a ? "home" : "away", weight: 0.75, source: "赛前亚盘水位" });
  if (market.status === "ok" && market.side) ahVotes.push({ side: market.side, weight: 0.75, source: "Polymarket 公开市场" });
  const ahPick = chooseSide(ahVotes);
  const ahScore = ahModelScore(ps, ah, eu, market, panorama);

  const ouVotes: { side: OuSide; weight: number; source: string }[] = [];
  const uoSide = parseUo(ps);
  if (uoSide) ouVotes.push({ side: uoSide, weight: ps?.derived ? 1 : 2, source: ps?.derived ? "指数派生大小方向" : "预测模型方向" });
  if (ou && ou.h !== ou.a) ouVotes.push({ side: ou.h < ou.a ? "over" : "under", weight: 0.75, source: "赛前大小球水位" });
  const goalSum = goalsTotal(ps);
  if (goalSum != null && ou?.line != null && Math.abs(goalSum - ou.line) >= 0.25) {
    ouVotes.push({ side: goalSum > ou.line ? "over" : "under", weight: 1, source: "进球模型" });
  }
  const ouPick = chooseSide(ouVotes);
  const ouScore = ouModelScore(ps, ou, panorama);
  const scoreSideAh: AhSide | null = ahScore.score == null || Math.abs(ahScore.score) < 8 ? null : ahScore.score > 0 ? "home" : "away";
  const scoreSideOu: OuSide | null = ouScore.score == null || Math.abs(ouScore.score) < 8 ? null : ouScore.score > 0 ? "over" : "under";

  const ahSignal: DirectionSignal = ahPick
    ? { status: "ok", text: ahDirectionText(ahPick.side, ah?.line ?? null), side: ahPick.side, line: ah?.line ?? null, sources: ahPick.sources }
    : scoreSideAh
      ? { status: "ok", text: ahDirectionText(scoreSideAh, ah?.line ?? null), side: scoreSideAh, line: ah?.line ?? null, sources: ["量化评分模型"] }
    : { status: "open", text: "暂无明确亚盘方向", side: null, line: ah?.line ?? null, sources: [] };
  const ouSignal: DirectionSignal = ouPick
    ? { status: "ok", text: ouDirectionText(ouPick.side, ou?.line ?? null), side: ouPick.side, line: ou?.line ?? null, sources: ouPick.sources }
    : scoreSideOu
      ? { status: "ok", text: ouDirectionText(scoreSideOu, ou?.line ?? null), side: scoreSideOu, line: ou?.line ?? null, sources: ["量化评分模型"] }
    : { status: "open", text: "暂无明确大小球方向", side: null, line: ou?.line ?? null, sources: [] };
  const inputs = [...ahScore.inputs, ...ouScore.inputs];
  const coverage = Math.round((ahScore.coverage + ouScore.coverage) / 2);
  const model = {
    method: "动态权重:v1.1;可用真实信号归一化加权,缺失维度自动剔除并披露",
    coverage,
    ahScore: ahScore.score,
    ouScore: ouScore.score,
    inputs,
  };
  const summary =
    ahSignal.status === "ok" || ouSignal.status === "ok"
      ? `综合方向:${ahSignal.text};${ouSignal.text}`
      : "综合方向暂无足够真实信号";
  return { ah: ahSignal, ou: ouSignal, market, model, summary };
}
