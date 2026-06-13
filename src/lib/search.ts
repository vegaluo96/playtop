export interface SearchField {
  value: unknown;
  weight?: number;
}

export function normalizeSearchText(v: unknown): string {
  return String(v ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[·•|/\\,，.。:：;；()（）[\]【】{}<>《》"'“”‘’_+\-=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactSearchText(v: unknown): string {
  return normalizeSearchText(v).replace(/\b(vs?|versus)\b/g, "").replace(/\s+/g, "");
}

export function searchTokens(q: string): string[] {
  return normalizeSearchText(q).split(" ").filter(Boolean).slice(0, 6);
}

export function scoreSearchFields(query: string, fields: SearchField[]): number {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return 1;

  const prepared = fields
    .map((field) => {
      const norm = normalizeSearchText(field.value);
      return norm ? { norm, compact: compactSearchText(norm), weight: field.weight ?? 1 } : null;
    })
    .filter(Boolean) as { norm: string; compact: string; weight: number }[];
  if (prepared.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    const compactToken = compactSearchText(token);
    let best = 0;
    for (const field of prepared) {
      const { norm, compact, weight } = field;
      if (norm === token || compact === compactToken) best = Math.max(best, 48 * weight);
      else if (norm.startsWith(token) || compact.startsWith(compactToken)) best = Math.max(best, 28 * weight);
      else if (norm.includes(token)) best = Math.max(best, 16 * weight);
      else if (compactToken && compact.includes(compactToken)) best = Math.max(best, 13 * weight);
    }
    if (best <= 0) return 0;
    score += best;
  }
  return score;
}
