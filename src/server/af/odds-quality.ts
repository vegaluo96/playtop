/** Odds quality gates shared by ingestion and public views. */

export const LIVE_EU_DISPLAY_MAX_ODD = 20;
export const MIN_DECIMAL_ODD = 1.01;
export const MAX_DECIMAL_ODD = 30;

export function isFulltimeResultMarketName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "fulltime result" || normalized === "full time result" || normalized === "match winner" || normalized === "1x2";
}

export function isHalfPeriodMarketName(name: string): boolean {
  return /first half|1st half|second half|2nd half|half time|halftime|\bht\b/i.test(name);
}

export function euMargin(h: number, d: number, a: number): number {
  return 1 / h + 1 / d + 1 / a;
}

export function isQuarterLine(line: number): boolean {
  return Number.isFinite(line) && Math.abs(line * 4 - Math.round(line * 4)) < 1e-9;
}

export function isValidAhLine(line: number): boolean {
  return isQuarterLine(line) && line >= -4.5 && line <= 4.5;
}

export function isValidOuLine(line: number): boolean {
  return isQuarterLine(line) && line >= 0.5 && line <= 8.5;
}

export function isValidDecimalOdd(odd: number): boolean {
  return Number.isFinite(odd) && odd >= MIN_DECIMAL_ODD && odd <= MAX_DECIMAL_ODD;
}

export function isValidEuTriplet(h: number, d: number | null | undefined, a: number): boolean {
  if (!isValidDecimalOdd(h) || !isValidDecimalOdd(d ?? NaN) || !isValidDecimalOdd(a)) return false;
  const margin = euMargin(h, d as number, a);
  return margin >= 1.0 && margin <= 1.25;
}

/**
 * User-facing live 1X2 gate.
 * AF can expose minute-scoped 1X2 ladders or transient extreme frames while live
 * markets suspend/reopen. Keep raw fetches auditable, but do not let those frames
 * drive main cards, charts, history drawers, or movement feeds.
 */
export function isDisplayableLiveEuTriplet(h: number, d: number | null | undefined, a: number): boolean {
  return isValidEuTriplet(h, d, a) && Math.max(h, d ?? 0, a) <= LIVE_EU_DISPLAY_MAX_ODD;
}

export function isDisplayableLiveEuMovement(fromH: number, toH: number, fromA: number, toA: number): boolean {
  return Math.max(fromH, toH, fromA, toA) <= LIVE_EU_DISPLAY_MAX_ODD;
}
