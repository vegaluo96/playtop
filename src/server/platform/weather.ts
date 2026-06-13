/**
 * 比赛天气:挪威国家气象局 MET Norway(官方/免费/免注册/允许商用,CC-BY 注明来源)。
 * 链路:球场城市名 → Open-Meteo 免费地理编码(经纬度,成功永久缓存)→ MET locationforecast
 * 取开球时刻最近的预报点(温度/湿度/风速/气压/天况),按场次缓存 3h。
 * 失败负缓存 10min(详情页 3s 轮询不能被出网超时拖慢);任一环拿不到返回 null,
 * 前端不显示——绝不伪造天气。预报点离开球 >2.5h 同样弃用。
 */
import { kvGet, kvSet } from "../af/store";
import { recordDiagnosticIssue, type DiagnosticSeverity } from "../af/diagnostics";

const UA = "zsky-football-sky/1.0 zsky.com (contact: admin@zsky.com)";
const H = 3_600_000;

function recordWeatherIssue(args: {
  endpoint: "weather.geocode" | "weather.forecast";
  fixtureId?: number | null;
  errorType: string;
  errorReason: string;
  severity?: DiagnosticSeverity;
  rawValue?: unknown;
  parsedValue?: unknown;
}): void {
  try {
    recordDiagnosticIssue({
      source: "WEATHER",
      endpoint: args.endpoint,
      fixtureId: args.fixtureId ?? null,
      rawValue: args.rawValue,
      parsedValue: args.parsedValue,
      errorType: args.errorType,
      errorReason: args.errorReason,
      severity: args.severity ?? "info",
    });
  } catch {
    /* optional data diagnostics must not break detail page rendering */
  }
}

const SYMBOL_ZH: [RegExp, string][] = [
  [/^clearsky/, "晴"],
  [/^fair/, "局部有云"],
  [/^partlycloudy/, "多云"],
  [/^cloudy/, "阴"],
  [/lightrainshowers|lightrain/, "小雨"],
  [/heavyrainshowers|heavyrain/, "大雨"],
  [/rainshowers|rain/, "有雨"],
  [/lightsnow|snowshowers|snow/, "有雪"],
  [/sleet/, "雨夹雪"],
  [/fog/, "雾"],
  [/thunder/, "雷雨"],
];
export function symbolZh(code: string): string {
  return SYMBOL_ZH.find(([re]) => re.test(code))?.[1] ?? "—";
}

export interface MatchWeather {
  temp: number; // ℃
  text: string; // 中文天况
  humidity: number; // %
  wind: number; // m/s
  pressure: number; // hPa
  src: string;
}

/** 成功/失败双 TTL 缓存:失败(null)短缓存,避免反复打超时请求拖慢请求路径 */
async function cached<T>(
  key: string,
  okTtl: number,
  failTtl: number,
  fn: () => Promise<T | null>,
  opts: { onError?: (e: unknown) => void } = {},
): Promise<T | null> {
  const raw = kvGet(key);
  if (raw) {
    try {
      const { at, data } = JSON.parse(raw) as { at: number; data: T | null };
      if (Date.now() - at < (data == null ? failTtl : okTtl)) return data;
    } catch {
      /* 重新拉 */
    }
  }
  const data = await fn().catch((e) => {
    opts.onError?.(e);
    return null;
  });
  kvSet(key, JSON.stringify({ at: Date.now(), data }));
  return data;
}

async function geocode(city: string): Promise<{ lat: number; lon: number } | null> {
  if (!city) return null;
  return cached(`geo:${city}`, 365 * 24 * H, 10 * 60_000, async () => {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5_000) },
    ).then((x) => x.json() as Promise<{ results?: { latitude: number; longitude: number }[] }>);
    const g = r.results?.[0];
    return g ? { lat: Math.round(g.latitude * 100) / 100, lon: Math.round(g.longitude * 100) / 100 } : null;
  });
}

/** 开球时刻的球场天气;城市未知/接口失败/预报覆盖不到开球时刻 → null */
export async function matchWeather(city: string, kickoffUtcMs: number, opts: { fixtureId?: number | null } = {}): Promise<MatchWeather | null> {
  // MET 预报约覆盖未来 9 天;过早查到的是错误时点,完场太久预报也已无意义
  const dt = kickoffUtcMs - Date.now();
  if (!city.trim()) {
    recordWeatherIssue({
      endpoint: "weather.geocode",
      fixtureId: opts.fixtureId,
      errorType: "WEATHER_CITY_MISSING",
      errorReason: "fixture venue.city 为空,无法查询球场天气",
      rawValue: { city },
      parsedValue: { kickoffUtcMs },
    });
    return null;
  }
  if (dt > 9 * 24 * H || dt < -6 * H) {
    recordWeatherIssue({
      endpoint: "weather.forecast",
      fixtureId: opts.fixtureId,
      errorType: "WEATHER_OUT_OF_RANGE",
      errorReason: "开球时间超出天气预报有效窗口,不展示天气",
      rawValue: { dtHours: Math.round(dt / H), kickoffUtcMs },
      parsedValue: { city },
    });
    return null;
  }
  const geo = await geocode(city);
  if (!geo) {
    recordWeatherIssue({
      endpoint: "weather.geocode",
      fixtureId: opts.fixtureId,
      errorType: "WEATHER_GEOCODE_EMPTY",
      errorReason: "Open-Meteo 未返回该球场城市的可用经纬度",
      rawValue: { city },
      parsedValue: { kickoffUtcMs },
    });
    return null;
  }
  const hourKey = Math.floor(kickoffUtcMs / H);
  const weather = await cached(`wx:${geo.lat},${geo.lon}:${hourKey}`, 3 * H, 10 * 60_000, async () => {
    const r = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${geo.lat}&lon=${geo.lon}`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(6_000),
    }).then((x) => x.json() as Promise<{ properties?: { timeseries?: { time: string; data: Record<string, unknown> }[] } }>);
    const series = r.properties?.timeseries ?? [];
    if (series.length === 0) return null;
    // 取与开球时刻最近的预报点;离得太远(>2.5h)宁可不显示
    const best = series.reduce((b, t) => {
      const d = Math.abs(Date.parse(t.time) - kickoffUtcMs);
      return d < Math.abs(Date.parse(b.time) - kickoffUtcMs) ? t : b;
    });
    if (Math.abs(Date.parse(best.time) - kickoffUtcMs) > 2.5 * H) return null;
    const inst = (best.data as { instant?: { details?: Record<string, number> } }).instant?.details ?? {};
    const sym =
      ((best.data as Record<string, { summary?: { symbol_code?: string } }>).next_1_hours?.summary?.symbol_code ??
        (best.data as Record<string, { summary?: { symbol_code?: string } }>).next_6_hours?.summary?.symbol_code) ?? "";
    const temp = inst["air_temperature"];
    if (temp == null) return null;
    return {
      temp: Math.round(temp),
      text: symbolZh(sym),
      humidity: Math.round(inst["relative_humidity"] ?? 0),
      wind: Math.round((inst["wind_speed"] ?? 0) * 10) / 10,
      pressure: Math.round(inst["air_pressure_at_sea_level"] ?? 0),
      src: "挪威气象局 MET Norway",
    };
  }, {
    onError: (e) =>
      recordWeatherIssue({
        endpoint: "weather.forecast",
        fixtureId: opts.fixtureId,
        errorType: "WEATHER_FORECAST_ERROR",
        errorReason: "MET Norway 天气预报接口请求失败",
        severity: "warn",
        rawValue: e instanceof Error ? e.message : String(e),
        parsedValue: { city, geo, kickoffUtcMs },
      }),
  });
  if (!weather) {
    recordWeatherIssue({
      endpoint: "weather.forecast",
      fixtureId: opts.fixtureId,
      errorType: "WEATHER_FORECAST_EMPTY",
      errorReason: "MET Norway 未返回覆盖开球时刻的可用天气点",
      rawValue: { city, geo, kickoffUtcMs },
      parsedValue: { hourKey },
    });
  }
  return weather;
}
