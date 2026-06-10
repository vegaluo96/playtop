/** 全站唯一的"当前时间"出口；FAKE_NOW（epoch 毫秒）供端到端模拟推进时间 */
export function now(): number {
  const fake = process.env.FAKE_NOW;
  if (fake && /^\d+$/.test(fake)) return Number(fake);
  return Date.now();
}
