import { dig } from "@/lib/dig";

export function publicImageUrl(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function teamLogoFromFixturePayload(payload: unknown, side: "home" | "away"): string | null {
  let obj: unknown = payload;
  if (typeof payload === "string") {
    try {
      obj = JSON.parse(payload) as unknown;
    } catch {
      obj = null;
    }
  }
  return publicImageUrl(dig(obj, "teams", side, "logo"));
}
