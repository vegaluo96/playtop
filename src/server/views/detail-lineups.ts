import { nameZh } from "./names";
import { dig } from "@/lib/dig";

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

interface LineupPlayer {
  n: string;
  num: number | null;
  pos: string;
  id: number | null;
}

/**
 * AF lineup.grid = "行:列":行 1 = 门将,行号沿进攻方向递增;列在行内从 1 递增。
 * 朝向对齐百度体育(中文用户基准):门将在顶、前锋在底 → 行号升序渲染。
 * 列向实测:AF 列 1 对应百度的最右 → 列降序。
 */
function lineupSide(lu: unknown) {
  const rowsMap = new Map<number, { col: number; p: LineupPlayer }[]>();
  const noGrid: { col: number; p: LineupPlayer }[] = [];
  arr(dig(lu, "startXI")).forEach((p, idx) => {
    const grid = String(dig(p, "player", "grid") ?? "");
    const [row, col] = grid.split(":").map(Number);
    const player: LineupPlayer = {
      n: nameZh(String(dig(p, "player", "name") ?? ""), "player"),
      num: (Number(dig(p, "player", "number")) || null) as number | null,
      pos: String(dig(p, "player", "pos") ?? ""),
      id: (Number(dig(p, "player", "id")) || null) as number | null,
    };
    if (!Number.isFinite(row)) {
      noGrid.push({ col: idx, p: player });
      return;
    }
    if (!rowsMap.has(row)) rowsMap.set(row, []);
    rowsMap.get(row)!.push({ col: col || 0, p: player });
  });
  const rows = [...rowsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ps]) => ps.sort((x, y) => y.col - x.col).map((c) => c.p));
  if (noGrid.length > 0) rows.push(noGrid.sort((x, y) => y.col - x.col).map((c) => c.p));
  const subs: LineupPlayer[] = arr(dig(lu, "substitutes")).map((p) => ({
    n: nameZh(String(dig(p, "player", "name") ?? ""), "player"),
    num: (Number(dig(p, "player", "number")) || null) as number | null,
    pos: String(dig(p, "player", "pos") ?? ""),
    id: (Number(dig(p, "player", "id")) || null) as number | null,
  }));
  return {
    form: String(dig(lu, "formation") ?? ""),
    coach: nameZh(String(dig(lu, "coach", "name") ?? ""), "coach"),
    rows,
    subs,
  };
}

export function lineupsView(bundle: Record<string, unknown>, homeId: number | null, homeName = "", awayName = "") {
  const lus = arr(bundle.lineups);
  if (lus.length < 2) return { ready: false as const };
  const byId = lus.find((l) => Number(dig(l, "team", "id")) === homeId);
  const byName = lus.find((l) => String(dig(l, "team", "name") ?? "") === homeName);
  const home = byId ?? byName;
  if (!home) return { ready: false as const };
  const away = lus.find((l) => l !== home);
  if (!away) return { ready: false as const };
  const awayOk = Number(dig(away, "team", "id")) !== homeId && String(dig(away, "team", "name") ?? "") !== homeName;
  if (!awayOk) return { ready: false as const };
  void awayName;
  return { ready: true as const, home: lineupSide(home), away: lineupSide(away) };
}

export type LineupsView = ReturnType<typeof lineupsView>;
