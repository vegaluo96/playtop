"use client";

/** 管理端统一请求封装 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.data as T;
}

export function fmtTs(t: number | null | undefined): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
