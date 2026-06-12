import { isFinished, isLive } from "../af/schedule";
import type { SynthEvent } from "../af/events-synth";
import { kvGet } from "../af/store";
import { nameZh } from "./names";

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const STAT_ZH: [string, string][] = [
  ["Ball Possession", "控球率"],
  ["expected_goals", "预期进球 xG"],
  ["Total Shots", "射门"],
  ["Shots on Goal", "射正"],
  ["Shots off Goal", "射偏"],
  ["Blocked Shots", "被封堵"],
  ["Shots insidebox", "禁区内射门"],
  ["Shots outsidebox", "禁区外射门"],
  ["Corner Kicks", "角球"],
  ["Offsides", "越位"],
  ["Fouls", "犯规"],
  ["Yellow Cards", "黄牌"],
  ["Red Cards", "红牌"],
  ["Goalkeeper Saves", "门将扑救"],
  ["Total passes", "传球"],
  ["Passes accurate", "传球成功"],
  ["Passes %", "传球成功率"],
];

export function liveStats(bundle: Record<string, unknown>, homeId: number | null) {
  const blocks = arr(bundle.statistics);
  if (blocks.length < 2) return null;
  const side = (b: unknown) => (Number(dig(b, "team", "id")) === homeId ? "h" : "a");
  const get = (b: unknown, type: string) => {
    const row = arr(dig(b, "statistics")).find((s) => dig(s, "type") === type);
    const v = row ? dig(row, "value") : null;
    return v == null ? null : String(v);
  };
  const home = blocks.find((b) => side(b) === "h");
  const away = blocks.find((b) => side(b) === "a");
  if (!home || !away) return null;
  return STAT_ZH.map(([type, label]) => {
    const lv = get(home, type) ?? "0";
    const rv = get(away, type) ?? "0";
    const num = (s: string) => parseFloat(s.replace("%", "")) || 0;
    return { label, lv, rv, l: num(lv), r: num(rv) };
  }).filter((row) => row.lv !== "0" || row.rv !== "0");
}

export interface TimelineRow {
  o: number;
  m: string;
  side: "h" | "a" | "mid";
  kind: string;
  text: string;
  live: string;
}

const SYNTH_TL: Record<string, { short: string; unit: string; live: (t: string, seq: number, m: number) => string }> = {
  corner: { short: "角球", unit: "个", live: (t, seq, m) => `第 ${m} 分钟,${t}获得角球,这是他们本场第 ${seq} 个角球。` },
  sot: { short: "射正", unit: "次", live: (t, seq, m) => `第 ${m} 分钟,${t}完成一次射正(本队第 ${seq} 次)。` },
  soff: { short: "射偏", unit: "次", live: (t, seq, m) => `第 ${m} 分钟,${t}射门偏出(本队第 ${seq} 次射偏)。` },
  offside: { short: "越位", unit: "次", live: (t, seq, m) => `第 ${m} 分钟,${t}进攻越位(本队第 ${seq} 次)。` },
};

export function timelineView(
  bundle: Record<string, unknown>,
  fx: { status: string; elapsed: number | null; home_id: number | null; home_name: string; away_name: string; goals_home: number | null; goals_away: number | null },
  synth: SynthEvent[],
) {
  const home = nameZh(fx.home_name);
  const away = nameZh(fx.away_name);
  const teamOf = (s: "h" | "a") => (s === "h" ? home : away);
  const rows: TimelineRow[] = [];

  let gh = 0;
  let ga = 0;
  const realEvents = arr(bundle.events).sort((a, b) => {
    const ma = Number(dig(a, "time", "elapsed")) || 0;
    const mb = Number(dig(b, "time", "elapsed")) || 0;
    const ea = Number(dig(a, "time", "extra")) || 0;
    const eb = Number(dig(b, "time", "extra")) || 0;
    return ma + ea / 100 - (mb + eb / 100);
  });
  for (const e of realEvents) {
    const type = String(dig(e, "type") ?? "");
    const detail = String(dig(e, "detail") ?? "");
    const m = Number(dig(e, "time", "elapsed")) || 0;
    const extra = Number(dig(e, "time", "extra")) || 0;
    const side: "h" | "a" = Number(dig(e, "team", "id")) === fx.home_id ? "h" : "a";
    const player = nameZh(String(dig(e, "player", "name") ?? ""), "player");
    const assistRaw = dig(e, "assist", "name");
    const assist = assistRaw ? nameZh(String(assistRaw), "player") : "";
    const ml = extra > 0 ? `${m}+${extra}'` : `${m}'`;
    const o = m + extra / 100;
    if (type === "Goal" && !/missed/i.test(detail)) {
      if (side === "h") gh++;
      else ga++;
      const tag = /penalty/i.test(detail) ? "(点球)" : /own goal/i.test(detail) ? "(乌龙)" : "";
      rows.push({
        o, m: ml, side, kind: "goal",
        text: `${player}${tag} ${gh}-${ga}`,
        live: `第 ${m} 分钟,进球!${teamOf(side)} ${player} 破门${tag}${assist ? `,${assist} 助攻` : ""},当前比分 ${gh}-${ga}。`,
      });
    } else if (type === "Card") {
      const red = /red/i.test(detail);
      rows.push({
        o, m: ml, side, kind: red ? "red" : "yellow",
        text: player || "—",
        live: `第 ${m} 分钟,${teamOf(side)} ${player} 被出示${red ? "红牌" : "黄牌"}。`,
      });
    } else if (type === "subst") {
      rows.push({
        o, m: ml, side, kind: "sub",
        text: `${player} ⇄ ${assist}`,
        live: `第 ${m} 分钟,${teamOf(side)}进行人员调整:${player} ⇄ ${assist}。`,
      });
    } else if (type === "Var") {
      rows.push({ o, m: ml, side, kind: "var", text: `VAR:${detail}`, live: `第 ${m} 分钟,VAR 介入审核:${detail}。` });
    }
  }

  for (const s of synth) {
    if (s.side === "mid") continue;
    const t = SYNTH_TL[s.kind];
    if (!t) continue;
    rows.push({
      o: s.m + 0.005,
      m: `${s.m}'`,
      side: s.side,
      kind: s.kind,
      text: s.seq != null ? `${t.short} 第${s.seq}${t.unit}` : t.short,
      live: t.live(teamOf(s.side), s.seq ?? 0, s.m),
    });
  }

  const nodes = new Map<string, { m: number; score: string | null }>();
  for (const s of synth) if (s.side === "mid") nodes.set(s.kind, { m: s.m, score: s.score ?? null });
  const started = isLive(fx.status) || isFinished(fx.status);
  const hth = dig(bundle, "score", "halftime", "home");
  const htScore = hth != null ? `${hth}-${dig(bundle, "score", "halftime", "away")}` : null;
  const finScore = fx.goals_home != null ? `${fx.goals_home}-${fx.goals_away}` : null;
  if (started && !nodes.has("kickoff")) nodes.set("kickoff", { m: 0, score: "0-0" });
  if (started && fx.status !== "1H" && !nodes.has("ht") && htScore) nodes.set("ht", { m: 45, score: htScore });
  if ((["2H", "ET", "BT", "P"].includes(fx.status) || isFinished(fx.status)) && nodes.has("ht") && !nodes.has("2h"))
    nodes.set("2h", { m: 46, score: nodes.get("ht")!.score });
  if (isFinished(fx.status) && !nodes.has("ft")) nodes.set("ft", { m: fx.elapsed ?? 90, score: finScore });
  const NODE_TXT: Record<string, { o: number; text: (s: string | null) => string; live: (s: string | null) => string }> = {
    kickoff: { o: -1, text: () => "比赛开始", live: () => "比赛正式开始。" },
    ht: { o: 45.98, text: (s) => `中场 ${s ?? ""}`.trim(), live: (s) => `上半场结束${s ? `,半场比分 ${s}` : ""}。` },
    "2h": { o: 45.99, text: () => "下半场", live: () => "下半场比赛开始。" },
    ft: { o: 999, text: (s) => `完场 ${s ?? ""}`.trim(), live: (s) => `全场比赛结束${s ? `,最终比分 ${s}` : ""}。` },
  };
  for (const [kind, n] of nodes) {
    const t = NODE_TXT[kind];
    if (t) rows.push({ o: t.o, m: "", side: "mid", kind, text: t.text(n.score), live: t.live(n.score) });
  }

  rows.sort((a, b) => a.o - b.o).reverse();

  let corners: { h: number; a: number } | null = null;
  const blocks = arr(bundle.statistics);
  if (blocks.length >= 2) {
    const of = (b: unknown) => {
      const row = arr(dig(b, "statistics")).find((s) => dig(s, "type") === "Corner Kicks");
      return Number(dig(row, "value")) || 0;
    };
    const hb = blocks.find((b) => Number(dig(b, "team", "id")) === fx.home_id);
    const ab = blocks.find((b) => Number(dig(b, "team", "id")) !== fx.home_id);
    if (hb && ab) corners = { h: of(hb), a: of(ab) };
  }
  return { rows: rows.slice(0, 200), corners, ht: htScore };
}

export function halfStats(fixtureId: number, homeId: number | null) {
  const raw = kvGet(`fx:${fixtureId}:stats_half`);
  if (!raw) return null;
  let blocks: unknown[];
  try {
    blocks = (JSON.parse(raw) as { data: unknown[] }).data ?? [];
  } catch {
    return null;
  }
  const teamOf = (b: unknown) => Number(dig(b, "team", "id"));
  const halfOf = (v: unknown): string | null => {
    if (v == null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    for (const k of ["1h", "halftime", "first_half", "firstHalf", "ht"]) {
      if (o[k] != null) return String(o[k]);
    }
    return null;
  };
  const pick = (teamId: number | null) => {
    const b = blocks.find((x) => teamOf(x) === teamId);
    const out = new Map<string, string>();
    for (const st of Array.isArray(dig(b, "statistics")) ? (dig(b, "statistics") as unknown[]) : []) {
      const h = halfOf(dig(st, "value"));
      if (h != null) out.set(String(dig(st, "type")), h);
    }
    return out;
  };
  const home = pick(homeId);
  const awayId = blocks.map(teamOf).find((id) => id !== homeId) ?? null;
  const away = pick(awayId);
  if (home.size === 0 && away.size === 0) return null;
  const rows = STAT_ZH.map(([type, label]) => ({ label, lv: home.get(type) ?? "—", rv: away.get(type) ?? "—" })).filter(
    (r) => r.lv !== "—" || r.rv !== "—",
  );
  return rows.length > 0 ? rows : null;
}
