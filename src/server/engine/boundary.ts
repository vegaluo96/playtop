/**
 * 最低可接受赔率（边界线）：margin / 模型概率，保留两位小数。
 * 这是一个静态派生值——发布观点时印出，玩家在自己的平台看到实时价格后自行对照：
 * 低于边界线，该观点即失去参考价值。margin≤0 或概率非法时返回 0（边界机制关闭）。
 */
export function minAcceptableOdds(modelProb: number, margin: number): number {
  if (!(modelProb > 0) || !(margin > 0)) return 0;
  return Math.round((margin / modelProb) * 100) / 100;
}
