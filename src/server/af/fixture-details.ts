import { afErrorText, afGet, afHasErrors, type AfEnvelope } from "./client";
import { recordDiagnosticIssue } from "./diagnostics";
import { isFinished, isLive } from "./schedule";
import { archiveAfRawPayload, mergeFixturePayload, type AfRawPayloadInput, type FixtureRow } from "./store";

export type FixtureDetailKey = "events" | "statistics" | "lineups" | "players";
export type FixtureDetailParts = Partial<Record<FixtureDetailKey, boolean>>;

const DETAIL_ENDPOINTS: Record<FixtureDetailKey, { metric: AfRawPayloadInput["endpoint"]; path: (fixtureId: number) => string }> = {
  events: { metric: "fixtures.events", path: (fixtureId) => `/fixtures/events?fixture=${fixtureId}` },
  statistics: { metric: "fixtures.statistics", path: (fixtureId) => `/fixtures/statistics?fixture=${fixtureId}` },
  lineups: { metric: "fixtures.lineups", path: (fixtureId) => `/fixtures/lineups?fixture=${fixtureId}` },
  players: { metric: "fixtures.players", path: (fixtureId) => `/fixtures/players?fixture=${fixtureId}` },
};

type DetailFetcher = (metric: AfRawPayloadInput["endpoint"], path: string) => Promise<AfEnvelope>;

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function anyPart(parts: FixtureDetailParts): boolean {
  return Object.values(parts).some(Boolean);
}

function detailEmptyReason(key: FixtureDetailKey): string {
  if (key === "lineups") return "AF 未返回首发阵容;可能尚未公布或该赛事无阵容覆盖";
  if (key === "events") return "AF 未返回赛况事件;可能尚未开赛、事件未产生或该赛事无事件覆盖";
  if (key === "statistics") return "AF 未返回技术统计;可能尚未开赛、统计未发布或该赛事无统计覆盖";
  return "AF 未返回单场球员数据;可能该赛事无球员级统计覆盖";
}

function recordFixtureDetailEmpty(fixtureId: number, endpoint: AfRawPayloadInput["endpoint"], key: FixtureDetailKey, env: AfEnvelope): void {
  recordDiagnosticIssue({
    endpoint,
    fixtureId,
    rawValue: { results: env.results, parameters: env.parameters, paging: env.paging },
    parsedValue: { part: key },
    errorType: "FIXTURE_DETAIL_EMPTY",
    errorReason: detailEmptyReason(key),
    severity: "info",
  });
}

function recordFixtureDetailError(fixtureId: number, endpoint: AfRawPayloadInput["endpoint"], key: FixtureDetailKey, env: AfEnvelope): void {
  recordDiagnosticIssue({
    endpoint,
    fixtureId,
    rawValue: env.errors,
    parsedValue: { part: key, parameters: env.parameters },
    errorType: "FIXTURE_DETAIL_ERROR",
    errorReason: `AF ${endpoint} 返回 errors:${afErrorText(env)}`,
    severity: "error",
  });
}

function recordFixtureDetailFetchError(fixtureId: number, endpoint: AfRawPayloadInput["endpoint"], key: FixtureDetailKey, error: unknown): void {
  recordDiagnosticIssue({
    endpoint,
    fixtureId,
    rawValue: error instanceof Error ? error.message : String(error),
    parsedValue: { part: key },
    errorType: "FIXTURE_DETAIL_FETCH_ERROR",
    errorReason: `AF ${endpoint} 请求失败`,
    severity: "error",
  });
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
    let env: AfEnvelope;
    try {
      env = await fetcher(endpoint.metric, endpoint.path(fixtureId));
    } catch (error) {
      recordFixtureDetailFetchError(fixtureId, endpoint.metric, key, error);
      continue;
    }
    const response = Array.isArray(env.response) ? env.response : [];
    const hasErrors = afHasErrors(env);
    if (response.length > 0 || hasErrors) {
      archiveAfRawPayload({
        endpoint: endpoint.metric,
        fixtureId,
        requestParams: { fixture: fixtureId },
        payload: env,
      });
    }
    if (hasErrors) {
      recordFixtureDetailError(fixtureId, endpoint.metric, key, env);
      continue;
    }
    if (response.length === 0) recordFixtureDetailEmpty(fixtureId, endpoint.metric, key, env);
    if (response.length > 0) patch[key] = response;
  }

  if ((opts.merge ?? true) && Object.keys(patch).length > 0) {
    mergeFixturePayload(fixtureId, patch, opts.updatedAt ?? Date.now());
  }
  return patch;
}
