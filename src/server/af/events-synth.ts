/**
 * 统计差分合成事件:AF events 不含角球/射正/射偏/越位的逐条事件,但滚球统计每分钟
 * 更新累计值——对累计值做差分即可还原「第 N 个角球(韩国)67'」。
 * 仅由真实统计变化合成,绝不虚构;首帧只记基线不补发历史(中途开始盯盘时序号仍正确)。
 * 状态切换(开赛/中场/下半场/完场)同样落为时间轴节点。
 * 存储:kv fx:{id}:synthev = { counts, status, events[] }(单场体量 < 100 条)。
 */
import { kvGet, kvSet, type FixtureRow } from "./store";

const TRACK: [string, string][] = [
  ["Corner Kicks", "corner"],
  ["Shots on Goal", "sot"],
  ["Shots off Goal", "soff"],
  ["Offsides", "offside"],
];

export interface SynthEvent {
  m: number; // 比赛分钟(事件发生时的 elapsed,精度=抓取间隔)
  side: "h" | "a" | "mid";
  kind: string; // corner|sot|soff|offside|kickoff|ht|2h|ft
  seq?: number;
  score?: string; // 状态节点附当时比分
  at: number;
}

interface SynthState {
  counts: Record<string, Record<string, number>>;
  status: string;
  events: SynthEvent[];
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

export function synthEventsOf(fixtureId: number): SynthEvent[] {
  try {
    return (JSON.parse(kvGet(`fx:${fixtureId}:synthev`) || "{}") as SynthState).events ?? [];
  } catch {
    return [];
  }
}

/** worker 每分钟调(滚球窗口内全部场次);幂等,无统计/无变化时零写入 */
export function synthFromFixture(fx: FixtureRow): void {
  let payload: unknown;
  try {
    payload = JSON.parse(fx.payload);
  } catch {
    return;
  }
  const key = `fx:${fx.fixture_id}:synthev`;
  let st: SynthState = { counts: {}, status: "NS", events: [] };
  try {
    const raw = kvGet(key);
    if (raw) st = { counts: {}, status: "NS", events: [], ...(JSON.parse(raw) as Partial<SynthState>) };
  } catch {
    /* 重建 */
  }
  let dirty = false;
  const now = Date.now();
  const m = fx.elapsed ?? 0;
  const score = fx.goals_home != null ? `${fx.goals_home}-${fx.goals_away}` : "0-0";

  // 状态节点(开赛/中场/下半场/完场)
  if (st.status !== fx.status) {
    const push = (kind: string) => st.events.push({ m, side: "mid", kind, score, at: now });
    if (st.status === "NS" && fx.status === "1H") push("kickoff");
    else if (fx.status === "HT") push("ht");
    else if (st.status === "HT" && fx.status === "2H") push("2h");
    else if (["FT", "AET", "PEN"].includes(fx.status) && !["FT", "AET", "PEN"].includes(st.status)) push("ft");
    st.status = fx.status;
    dirty = true;
  }

  // 统计差分(主/客两块)
  const blocks = arr(dig(payload, "statistics"));
  if (blocks.length >= 2) {
    for (const b of blocks) {
      const side: "h" | "a" = Number(dig(b, "team", "id")) === fx.home_id ? "h" : "a";
      const sideCounts = (st.counts[side] ??= {});
      for (const [afType, kind] of TRACK) {
        const row = arr(dig(b, "statistics")).find((s) => dig(s, "type") === afType);
        const cur = Number(dig(row, "value"));
        if (!Number.isFinite(cur)) continue;
        const prev = sideCounts[kind];
        if (prev == null) {
          sideCounts[kind] = cur; // 首帧:只记基线,不补发历史
          dirty = true;
          continue;
        }
        for (let seq = prev + 1; seq <= cur && seq <= prev + 5; seq++) {
          // 单帧增量 >5 视为数据修正,不刷屏
          st.events.push({ m, side, kind, seq, at: now });
        }
        if (cur !== prev) {
          sideCounts[kind] = cur;
          dirty = true;
        }
      }
    }
  }

  if (dirty) {
    if (st.events.length > 300) st.events = st.events.slice(-300);
    kvSet(key, JSON.stringify(st));
  }
}
