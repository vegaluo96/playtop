"use client";

/** 公共配置(/api/config)模块级缓存:联赛顺序/公告/版本/充值维护,一次拉取全站共享 */
import { useEffect, useState } from "react";

export interface SiteLeague {
  id: number;
  zh: string;
  color: string;
  on: boolean;
  wc?: boolean;
}
export interface SiteConfig {
  leagues: SiteLeague[];
  announcements: { id: number; text: string }[];
  version: string;
  rechargeMaintenance: boolean;
}

let cache: SiteConfig | null = null;
let inflight: Promise<SiteConfig | null> | null = null;

function fetchConfig(): Promise<SiteConfig | null> {
  if (cache) return Promise.resolve(cache);
  inflight ??= fetch("/api/config")
    .then((r) => r.json())
    .then((j) => (j.ok ? ((cache = j as SiteConfig), cache) : null))
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useSiteConfig(): SiteConfig | null {
  const [c, setC] = useState<SiteConfig | null>(cache);
  useEffect(() => {
    if (!cache) void fetchConfig().then((v) => v && setC(v));
  }, []);
  return c;
}
