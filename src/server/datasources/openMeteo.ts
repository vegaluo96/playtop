import { z } from "zod";
import { weatherPayloadSchema } from "./types";

/** open-meteo：地理编码 + 逐小时天气预报，均免费免 key */

export async function geocode(name: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: { latitude: number; longitude: number; name: string; country?: string }[];
  };
  const r = data.results?.[0];
  if (!r) return null;
  return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.country ? `, ${r.country}` : ""}` };
}

/** 取开球时刻最近一小时的天气（预报范围 ±16 天） */
export async function fetchKickoffWeather(
  lat: number,
  lon: number,
  kickoffAt: number,
): Promise<z.infer<typeof weatherPayloadSchema> | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=16&timezone=UTC`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    hourly?: { time: string[]; temperature_2m: number[]; precipitation: number[]; wind_speed_10m: number[] };
  };
  const h = data.hourly;
  if (!h?.time?.length) return null;
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(`${h.time[i]}:00Z`);
    const diff = Math.abs(t - kickoffAt);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  if (best < 0 || bestDiff > 2 * 3_600_000 + 16 * 86_400_000) return null;
  const temperatureC = h.temperature_2m[best] ?? null;
  const precipitationMmH = h.precipitation[best] ?? null;
  const windKmH = h.wind_speed_10m[best] ?? null;
  const parts: string[] = [];
  if (temperatureC !== null) parts.push(`气温 ${temperatureC}°C`);
  if (precipitationMmH !== null) parts.push(`降水 ${precipitationMmH}mm/h`);
  if (windKmH !== null) parts.push(`风速 ${windKmH}km/h`);
  return weatherPayloadSchema.parse({
    temperatureC,
    precipitationMmH,
    windKmH,
    summary: parts.join("，") || "无数据",
    forecastAt: kickoffAt,
  });
}
