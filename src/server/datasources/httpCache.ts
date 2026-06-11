import { eq } from "drizzle-orm";
import { db } from "../db";
import { fetchCache } from "../db/schema";
import { sha256Hex } from "../lib/hash";
import { recordRawPayload } from "../services/rawArchive";
import { now } from "../lib/time";

/** 同一 URL 的最小抓取间隔（礼貌限速） */
const MIN_INTERVAL_MS = 10 * 60_000;
const inflightCooldown = new Map<string, number>();

export interface FetchResult {
  body: string;
  changed: boolean;
  fromCache: boolean;
}

/**
 * 礼貌抓取：进程内冷却 + 内容哈希比对（未变化时 changed=false，调用方可跳过解析）。
 * force=true 跳过冷却（管理员手动触发）；headers 供需要浏览器 UA 的源覆盖。
 */
export async function politeFetchText(
  url: string,
  force = false,
  headers?: Record<string, string>,
): Promise<FetchResult> {
  const last = inflightCooldown.get(url) ?? 0;
  if (!force && now() - last < MIN_INTERVAL_MS) {
    throw new Error(`抓取过于频繁，请 ${Math.ceil((MIN_INTERVAL_MS - (now() - last)) / 60000)} 分钟后再试：${url}`);
  }
  inflightCooldown.set(url, now());
  const res = await fetch(url, {
    headers: { "user-agent": "playtop/1.0 (research; contact admin)", ...headers },
    signal: AbortSignal.timeout(12_000), // 被墙源常挂死而非拒绝——12s 截断保证并发批快速收敛
  });
  if (!res.ok) {
    recordRawPayload({ endpoint: url, httpStatus: res.status, body: null, errorMessage: `HTTP ${res.status}` });
    throw new Error(`抓取失败 HTTP ${res.status}：${url}`);
  }
  const body = await res.text();
  recordRawPayload({ endpoint: url, httpStatus: res.status, body }); // 合规铁律：原始响应原样留档
  const hash = sha256Hex(body);
  const cached = db.select().from(fetchCache).where(eq(fetchCache.url, url)).get();
  const changed = !cached || cached.contentHash !== hash;
  db.insert(fetchCache)
    .values({ url, contentHash: hash, fetchedAt: now() })
    .onConflictDoUpdate({ target: fetchCache.url, set: { contentHash: hash, fetchedAt: now() } })
    .run();
  return { body, changed, fromCache: false };
}

/** 简易 CSV 解析（支持双引号包裹字段），返回 {header, rows} */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQuote = false;
        } else cur += ch;
      } else if (ch === '"') inQuote = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]);
  return { header, rows: lines.slice(1).map(parseLine) };
}
