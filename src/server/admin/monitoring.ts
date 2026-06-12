export const ENDPOINT_SLOW_MS = 1500;

export function endpointHealthStatus(ms: number, ok: boolean): "正常" | "慢" | "异常" {
  if (!ok) return "异常";
  return ms > ENDPOINT_SLOW_MS ? "慢" : "正常";
}
