/**
 * Read-only AF detail calibration:
 * compares API-Football official fixture detail endpoints with the public
 * /api/match/<fixtureId>?deep=1 payload. It does not write DB/KV.
 */
import { loadEnvFile } from "../src/server/env-file";
loadEnvFile();
import { afGet } from "../src/server/af/client";
import { isFinished } from "../src/server/af/schedule";
import { fixturesBetween } from "../src/server/af/store";

type Status = "ok" | "warn" | "fail" | "missing";
type V = any;

const ICON: Record<Status, string> = { ok: "✓", warn: "△", fail: "✗", missing: "⊘" };
const H = 3_600_000;
const STAT_TYPES: [string, string][] = [
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

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function dig(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k as string];
    else return undefined;
  }
  return cur;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function ids(list: unknown[], path: (string | number)[]): number[] {
  return list.map((it) => Number(dig(it, ...path))).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

function eqSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function evKind(e: unknown): "goal" | "yellow" | "red" | "sub" | "var" | "other" {
  const type = String(dig(e, "type") ?? "").toLowerCase();
  const detail = String(dig(e, "detail") ?? "").toLowerCase();
  if (type === "goal") return "goal";
  if (type === "card" && detail.includes("red")) return "red";
  if (type === "card" && detail.includes("yellow")) return "yellow";
  if (type === "subst" || type === "substitution") return "sub";
  if (type === "var" || detail.includes("var")) return "var";
  return "other";
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((m, k) => {
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {} as Record<T, number>);
}

function row(status: Status, area: string, note: string): { status: Status; area: string; note: string } {
  return { status, area, note };
}

async function afArray(path: string): Promise<unknown[]> {
  const env = await afGet(path, { force: true });
  return arr(env.response);
}

async function publicMatch(base: string, fixtureId: number): Promise<V | null> {
  const r = await fetch(`${base.replace(/\/$/, "")}/api/match/${fixtureId}?deep=1`, { cache: "no-store" });
  const j = await r.json().catch(() => null);
  return j?.ok ? j : null;
}

function compareScore(afFixture: unknown, pub: V) {
  const gh = dig(afFixture, "goals", "home");
  const ga = dig(afFixture, "goals", "away");
  const status = String(dig(afFixture, "fixture", "status", "short") ?? "");
  const afScore = gh == null ? null : `${gh}-${ga}`;
  if (afScore !== pub.header?.score) return row("fail", "score", `AF ${status} ${afScore ?? "null"} vs public ${pub.header?.score ?? "null"}`);
  return row("ok", "score", `AF ${status} ${afScore ?? "null"}`);
}

function compareEvents(events: unknown[], pub: V) {
  const publicRows = arr(pub.tech?.timeline?.rows).filter((r) => !["kickoff", "ht", "2h", "ft"].includes(String(dig(r, "kind"))));
  if (events.length === 0) {
    return publicRows.length === 0
      ? row("ok", "events", "AF no events; public no real events")
      : row("warn", "events", `AF no events; public has ${publicRows.length} real/synthetic rows`);
  }
  const afCounts = countBy(events.map(evKind).filter((k) => k !== "other"));
  const publicCounts = countBy(publicRows.map((r) => String(dig(r, "kind")) as ReturnType<typeof evKind>).filter((k) => k !== "other"));
  const keys = ["goal", "yellow", "red", "sub", "var"] as const;
  const bad = keys.filter((k) => (afCounts[k] ?? 0) !== (publicCounts[k] ?? 0));
  if (bad.length > 0) return row("fail", "events", bad.map((k) => `${k} AF ${afCounts[k] ?? 0}/public ${publicCounts[k] ?? 0}`).join("; "));
  return row("ok", "events", keys.map((k) => `${k}:${afCounts[k] ?? 0}`).join(" "));
}

function compareStats(stats: unknown[], pub: V, homeId: number | null) {
  const publicStats = arr(pub.tech?.stats);
  if (stats.length === 0) return publicStats.length === 0 ? row("ok", "stats", "AF no stats; public no stats") : row("warn", "stats", "AF no stats but public exposes stats");
  if (publicStats.length === 0) return row("fail", "stats", `AF has ${stats.length} team stat blocks, public stats empty`);
  const home = stats.find((b) => Number(dig(b, "team", "id")) === homeId);
  const away = stats.find((b) => Number(dig(b, "team", "id")) !== homeId);
  const get = (b: unknown, type: string) => num(dig(arr(dig(b, "statistics")).find((s) => dig(s, "type") === type), "value"));
  const mismatch: string[] = [];
  for (const [type, label] of STAT_TYPES) {
    const p = publicStats.find((s) => dig(s, "label") === label);
    if (!p) continue;
    const h = get(home, type) ?? 0;
    const a = get(away, type) ?? 0;
    if (h !== num(dig(p, "l")) || a !== num(dig(p, "r"))) mismatch.push(`${label} AF ${h}-${a}/public ${dig(p, "l")}-${dig(p, "r")}`);
  }
  return mismatch.length > 0 ? row("fail", "stats", mismatch.slice(0, 4).join("; ")) : row("ok", "stats", `${publicStats.length} rows`);
}

function sideLineup(pubSide: V): { xi: number[]; subs: number[] } {
  return {
    xi: ids(arr(pubSide?.rows).flatMap((r) => arr(r)), ["id"]),
    subs: ids(arr(pubSide?.subs), ["id"]),
  };
}

function compareLineups(lineups: unknown[], pub: V, homeId: number | null) {
  const ready = pub.lineups?.ready === true;
  if (lineups.length === 0) return ready ? row("fail", "lineups", "AF no official lineups but public ready=true") : row("ok", "lineups", "AF no official lineups; public ready=false");
  if (!ready) return row("fail", "lineups", `AF has ${lineups.length} lineups but public ready=false`);
  const afHome = lineups.find((l) => Number(dig(l, "team", "id")) === homeId);
  const afAway = lineups.find((l) => Number(dig(l, "team", "id")) !== homeId);
  const afH = { xi: ids(arr(dig(afHome, "startXI")), ["player", "id"]), subs: ids(arr(dig(afHome, "substitutes")), ["player", "id"]) };
  const afA = { xi: ids(arr(dig(afAway, "startXI")), ["player", "id"]), subs: ids(arr(dig(afAway, "substitutes")), ["player", "id"]) };
  const pubH = sideLineup(pub.lineups.home);
  const pubA = sideLineup(pub.lineups.away);
  const bad: string[] = [];
  if (!eqSet(afH.xi, pubH.xi)) bad.push(`home XI AF ${afH.xi.length}/public ${pubH.xi.length}`);
  if (!eqSet(afA.xi, pubA.xi)) bad.push(`away XI AF ${afA.xi.length}/public ${pubA.xi.length}`);
  if (!eqSet(afH.subs, pubH.subs)) bad.push(`home subs AF ${afH.subs.length}/public ${pubH.subs.length}`);
  if (!eqSet(afA.subs, pubA.subs)) bad.push(`away subs AF ${afA.subs.length}/public ${pubA.subs.length}`);
  return bad.length > 0 ? row("fail", "lineups", bad.join("; ")) : row("ok", "lineups", "XI/sub IDs match AF");
}

function defaultFixtures(maxN: number): number[] {
  const now = Date.now();
  return fixturesBetween(now - 36 * H, now + 48 * H)
    .sort((a, b) => {
      const aw = isFinished(a.status) ? 0 : 1;
      const bw = isFinished(b.status) ? 0 : 1;
      return bw - aw || Math.abs(a.kickoff_utc - now) - Math.abs(b.kickoff_utc - now);
    })
    .slice(0, maxN)
    .map((f) => f.fixture_id);
}

async function main() {
  const base = arg("--base") ?? "https://zsky.com";
  const fixtureArg = arg("--fixtures");
  const max = Number(arg("--max") ?? 8);
  const fixtureIds = fixtureArg ? fixtureArg.split(",").map((x) => Number(x.trim())).filter(Boolean) : defaultFixtures(max);
  if (fixtureIds.length === 0) throw new Error("No fixtures to calibrate; pass --fixtures 1,2,3");

  const allRows: { fixtureId: number; status: Status; area: string; note: string }[] = [];
  for (const fixtureId of fixtureIds) {
    const afFixture = (await afArray(`/fixtures?id=${fixtureId}`))[0] ?? null;
    const pub = await publicMatch(base, fixtureId);
    if (!afFixture || !pub) {
      allRows.push({ fixtureId, ...row("missing", "fixture", `${afFixture ? "" : "AF missing"} ${pub ? "" : "public missing"}`.trim()) });
      continue;
    }
    const homeId = Number(dig(afFixture, "teams", "home", "id")) || null;
    const [events, stats, lineups] = await Promise.all([
      afArray(`/fixtures/events?fixture=${fixtureId}`),
      afArray(`/fixtures/statistics?fixture=${fixtureId}`),
      afArray(`/fixtures/lineups?fixture=${fixtureId}`),
    ]);
    const rows = [
      compareScore(afFixture, pub),
      compareEvents(events, pub),
      compareStats(stats, pub, homeId),
      compareLineups(lineups, pub, homeId),
    ];
    allRows.push(...rows.map((r) => ({ fixtureId, ...r })));
  }

  const counts = { ok: 0, warn: 0, fail: 0, missing: 0 };
  for (const r of allRows) counts[r.status]++;
  console.log(`■ AF detail public calibration · fixtures ${fixtureIds.length} · ✓${counts.ok} △${counts.warn} ✗${counts.fail} ⊘${counts.missing}`);
  for (const r of allRows) console.log(`  ${ICON[r.status]} fixture=${r.fixtureId} ${r.area}: ${r.note}`);
  if (counts.fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
