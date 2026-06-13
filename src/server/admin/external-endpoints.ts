import { kvGet, kvSet } from "../af/store";
import { endpointHealthStatus } from "./monitoring";

export interface ExternalEndpointHealth {
  k: string;
  kind: string;
  url: string;
  last_at: number;
  ms: number | null;
  status: "正常" | "慢" | "异常";
  note: string;
}

const CACHE_KEY = "admin:external-endpoints:v1";
const TTL_MS = 10 * 60_000;
const UA = "zsky-football-sky/1.0 zsky.com (contact: admin@zsky.com)";

async function timedProbe(args: {
  k: string;
  kind: string;
  url: string;
  note: string;
  headers?: HeadersInit;
  validate?: (json: unknown) => boolean;
}): Promise<ExternalEndpointHealth> {
  const t0 = Date.now();
  try {
    const res = await fetch(args.url, {
      headers: { accept: "application/json", ...(args.headers ?? {}) },
      signal: AbortSignal.timeout(3_000),
    });
    const json = await res.json().catch(() => null);
    const ok = res.ok && (args.validate ? args.validate(json) : true);
    const ms = Date.now() - t0;
    return {
      k: args.k,
      kind: args.kind,
      url: args.url,
      last_at: Date.now(),
      ms,
      status: endpointHealthStatus(ms, ok),
      note: ok ? args.note : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      k: args.k,
      kind: args.kind,
      url: args.url,
      last_at: Date.now(),
      ms: null,
      status: "异常",
      note: e instanceof Error ? e.message.slice(0, 80) : "探测失败",
    };
  }
}

function readCached(): ExternalEndpointHealth[] | null {
  const raw = kvGet(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at: number; data: ExternalEndpointHealth[] };
    return Date.now() - parsed.at < TTL_MS ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function probeExternalEndpoints(): Promise<ExternalEndpointHealth[]> {
  const cached = readCached();
  if (cached) return cached;
  const data = await Promise.all([
    timedProbe({
      k: "Polymarket Gamma",
      kind: "预测市场",
      url: "https://gamma-api.polymarket.com/public-search?q=football&cache=true&events_status=open&limit_per_type=1",
      note: "公开搜索可用",
      validate: (json) => Array.isArray((json as { events?: unknown[] } | null)?.events) || Array.isArray((json as { data?: unknown[] } | null)?.data) || Array.isArray(json),
    }),
    timedProbe({
      k: "Open-Meteo Geocoding",
      kind: "天气地理编码",
      url: "https://geocoding-api.open-meteo.com/v1/search?name=London&count=1",
      note: "城市经纬度解析可用",
      validate: (json) => Array.isArray((json as { results?: unknown[] } | null)?.results),
    }),
    timedProbe({
      k: "MET Norway Forecast",
      kind: "天气预测",
      url: "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=51.51&lon=-0.13",
      note: "开球天气预报可用",
      headers: { "user-agent": UA },
      validate: (json) => Array.isArray((json as { properties?: { timeseries?: unknown[] } } | null)?.properties?.timeseries),
    }),
  ]);
  kvSet(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  return data;
}
