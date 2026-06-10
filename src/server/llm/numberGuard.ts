/**
 * 防编造闸之二：数字白名单校验。
 * LLM 的定性段落原则上不允许出现任何数字（所有数字由代码模板渲染）；
 * 只放行事实清单中出现过的数字（如球衣号、年份、轮次）。
 * 中文数字仅在后接量词（球/分/场/次/个/名/连…）时才视为数字表述，避免"一定/统一"误伤。
 */

const ARABIC = /\d+(?:\.\d+)?%?/g;
const CHINESE = /[零一二两三四五六七八九十百千万亿]{1,6}(?=[球分场次个名连粒度倍成])/g;

export function extractNumberTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.matchAll(ARABIC)) tokens.push(m[0]);
  for (const m of text.matchAll(CHINESE)) tokens.push(m[0]);
  return tokens;
}

/** 从事实清单构建白名单（事实中出现过的数字 + 常用序数"一/两/二/三"）*/
export function buildWhitelist(facts: string[]): Set<string> {
  const wl = new Set<string>(["一", "两", "二", "三"]);
  for (const f of facts) {
    for (const t of extractNumberTokens(f)) {
      wl.add(t);
      if (t.endsWith("%")) wl.add(t.slice(0, -1));
    }
  }
  return wl;
}

export function findViolations(text: string, whitelist: Set<string>): string[] {
  return extractNumberTokens(text).filter((t) => !whitelist.has(t) && !whitelist.has(t.replace("%", "")));
}
