/**
 * 名称汉化解析层(球队/国家队/教练/球员):
 *   内置词典(准确)→ name_zh 表(LLM 音译缓存)→ 原名 + 入队待译。
 * DB 永远存原名;仅视图层翻译。worker 每小时批量音译队列(30 条/次)。
 */
import { db } from "../db";
import { kvGet, kvSet } from "../af/store";
import { NAMES_ZH } from "@/lib/names-zh-dict";
import { chatComplete } from "../llm/client";
import { cfgLlmKey } from "../platform/config";

const QUEUE_KEY = "namezh:queue";
let tableCache: Map<string, string> | null = null;
let tableCacheAt = 0;

function tableMap(): Map<string, string> {
  if (tableCache && Date.now() - tableCacheAt < 60_000) return tableCache;
  const rows = db().prepare("SELECT raw, zh FROM name_zh").all() as unknown as { raw: string; zh: string }[];
  tableCache = new Map(rows.map((r) => [r.raw, r.zh]));
  tableCacheAt = Date.now();
  return tableCache;
}

function enqueue(raw: string, kind: string): void {
  try {
    const q = JSON.parse(kvGet(QUEUE_KEY) || "[]") as { raw: string; kind: string }[];
    if (q.length >= 500 || q.some((x) => x.raw === raw)) return;
    q.push({ raw, kind });
    kvSet(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* 队列损坏忽略,下轮重建 */
  }
}

/** 名称 → 中文(kind: team|player|coach;未命中返回原名并入队) */
export function nameZh(raw: string, kind: "team" | "player" | "coach" = "team"): string {
  const n = raw.trim();
  if (!n) return n;
  const dictHit = NAMES_ZH[n];
  if (dictHit) return dictHit;
  if (/[一-鿿]/.test(n)) return n; // 已是中文且无固定短名别名
  const hit = tableMap().get(n);
  if (hit) return hit;
  enqueue(n, kind);
  return n;
}

/** worker 每小时调:批量 LLM 音译队列,写 name_zh 表;返回译出条数 */
export async function drainNameQueue(batch = 30): Promise<number> {
  if (!cfgLlmKey()) return 0;
  let q: { raw: string; kind: string }[] = [];
  try {
    q = JSON.parse(kvGet(QUEUE_KEY) || "[]");
  } catch {
    /* 重建 */
  }
  if (q.length === 0) return 0;
  const take = q.slice(0, batch);
  const system =
    "你是体育译名专家。把给定的足球队名/球员名/教练名翻译成简体中文通用译名(球队用约定俗成译名,人名用新华社风格音译)。" +
    "只输出 JSON 对象:键为原文,值为中文译名。不输出其他内容。";
  const user = JSON.stringify(take.map((x) => x.raw));
  try {
    const r = await chatComplete(system, user, 1500);
    const text = r.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const map = JSON.parse(text) as Record<string, string>;
    const d = db();
    let n = 0;
    for (const item of take) {
      const zh = map[item.raw];
      if (zh && /[一-鿿]/.test(zh) && zh.length <= 20) {
        d.prepare("INSERT OR REPLACE INTO name_zh (raw, kind, zh, src, updated_at) VALUES (?,?,?,?,?)").run(
          item.raw, item.kind, zh.trim(), "llm", Date.now(),
        );
        n++;
      }
    }
    kvSet(QUEUE_KEY, JSON.stringify(q.slice(batch)));
    tableCache = null; // 失效缓存
    return n;
  } catch {
    return 0; // 失败保留队列下轮再试
  }
}
