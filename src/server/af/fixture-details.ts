import { afGet, type AfEnvelope } from "./client";
import { isFinished, isLive } from "./schedule";
import { mergeFixturePayload, type FixtureRow } from "./store";

export type FixtureDetailKey = "events" | "statistics" | "lineups" | "players";
export type FixtureDetailParts = Partial<Record<FixtureDetailKey, boolean>>;

const DETAIL_ENDPOINTS: Record<FixtureDetailKey, { metric: string; path: (fixtureId: number) => string }> = {
  events: { metric: "fixtures.events", path: (fixtureId) => `/fixtures/events?fixture=${fixtureId}` },
  statistics: { metric: "fixtures.statistics", path: (fixtureId) => `/fixtures/statistics?fixture=${fixtureId}` },
  lineups: { metric: "fixtures.lineups", path: (fixtureId) => `/fixtures/lineups?fixture=${fixtureId}` },
  players: { metric: "fixtures.players", path: (fixtureId) => `/fixtures/players?fixture=${fixtureId}` },
};

type DetailFetcher = (metric: string, path: string) => Promise<AfEnvelope>;

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function anyPart(parts: FixtureDetailParts): boolean {
  return Object.values(parts).some(Boolean);
}

export function fixtureDetailPartsForBundle(
  fx: Pick<FixtureRow, "kickoff_utc" | "status">,
  bundle: Record<string, unknown>,
  opts: { deep?: boolean; now?: number } = {},
): FixtureDetailParts {
  const now = opts.now ?? Date.now();
  const minsToKickoff = (fx.kickoff_utc - now) / 60_000;
  const lineupWindow = minsToKickoff <= 60;
  const startedOrFinal = isLive(fx.status) || isFinished(fx.status) || fx.kickoff_utc <= now;
  const parts: FixtureDetailParts = {};

  if (lineupWindow && arrLen(bundle.lineups) === 0) parts.lineups = true;
  if (startedOrFinal) {
    if (arrLen(bundle.events) === 0) parts.events = true;
    if (arrLen(bundle.statistics) === 0) parts.statistics = true;
    if (opts.deep && arrLen(bundle.players) === 0) parts.players = true;
  }
  return parts;
}

export function fixtureDetailPartKey(parts: FixtureDetailParts): string {
  return (Object.keys(DETAIL_ENDPOINTS) as FixtureDetailKey[]).filter((k) => parts[k]).join(",");
}

export async function refreshFixtureDetailsFromAf(
  fixtureId: number,
  parts: FixtureDetailParts,
  opts: { fetcher?: DetailFetcher; force?: boolean; merge?: boolean; updatedAt?: number } = {},
): Promise<Record<string, unknown[]>> {
  if (!anyPart(parts)) return {};
  const fetcher = opts.fetcher ?? ((_: string, path: string) => afGet(path, { force: opts.force ?? true }));
  const patch: Record<string, unknown[]> = {};

  for (const key of Object.keys(DETAIL_ENDPOINTS) as FixtureDetailKey[]) {
    if (!parts[key]) continue;
    const endpoint = DETAIL_ENDPOINTS[key];
    const env = await fetcher(endpoint.metric, endpoint.path(fixtureId));
    const response = Array.isArray(env.response) ? env.response : [];
    if (response.length > 0) patch[key] = response;
  }

  if ((opts.merge ?? true) && Object.keys(patch).length > 0) {
    mergeFixturePayload(fixtureId, patch, opts.updatedAt ?? Date.now());
  }
  return patch;
}
