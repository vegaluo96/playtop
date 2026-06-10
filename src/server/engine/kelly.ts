/**
 * Kelly (1956), "A New Interpretation of Information Rate", Bell System Technical Journal 35(4)。
 * f* = (p·o − 1)/(o − 1)；输出分数 Kelly（默认 1/4）并设仓位上限——业界标准的稳健化处理。
 */
export function kellyStake(
  p: number,
  odds: number,
  fraction: number,
  cap: number,
): number {
  if (odds <= 1) return 0;
  const f = (p * odds - 1) / (odds - 1);
  if (f <= 0) return 0;
  return Math.min(cap, f * fraction);
}

/** 期望值：EV = p·o − 1（单位本金） */
export function expectedValue(p: number, odds: number): number {
  return p * odds - 1;
}
