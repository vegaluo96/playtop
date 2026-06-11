"use client";

/**
 * 全局客户端状态:
 * - prefs:涨跌配色 / 外观 / 语言 / 时区 / 关注联赛(localStorage 持久化;
 *   配色与外观同步到 <html> 的 data-scheme / data-theme,供 CSS token 消费)
 * - me:登录态 + 积分(服务端 /api/me 为准;解锁状态服务端记账,前端只读)
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_LANG, type Lang } from "@/lib/i18n";

export type Scheme = "红升绿降" | "绿升红降";

export interface Prefs {
  scheme: Scheme;
  theme: "深色" | "浅色";
  lang: Lang;
  tz: string;
  follows: string[]; // 联赛 id(字符串)
}

export interface Me {
  loggedIn: boolean;
  email?: string;
  pts: number;
  giftPending?: boolean;
  inviteCode?: string;
}

interface Ctx {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  me: Me;
  refreshMe: () => Promise<void>;
}

const DEFAULT_PREFS: Prefs = { scheme: "红升绿降", theme: "深色", lang: DEFAULT_LANG, tz: "UTC+8", follows: [] };
const GUEST: Me = { loggedIn: false, pts: 0 };

const AppCtx = createContext<Ctx>({ prefs: DEFAULT_PREFS, setPrefs: () => {}, me: GUEST, refreshMe: async () => {} });

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [me, setMe] = useState<Me>(GUEST);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("playtop.prefs");
      if (raw) setPrefsState({ ...DEFAULT_PREFS, ...JSON.parse(raw) });
    } catch {
      /* 损坏的本地存储直接用默认 */
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.scheme = prefs.scheme === "绿升红降" ? "gr" : "rg";
    document.documentElement.dataset.theme = prefs.theme === "浅色" ? "light" : "dark";
  }, [prefs.scheme, prefs.theme]);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((old) => {
      const next = { ...old, ...p };
      try {
        localStorage.setItem("playtop.prefs", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const r = await fetch("/api/me", { cache: "no-store" });
      const j = await r.json();
      setMe(j.loggedIn ? j : GUEST);
    } catch {
      setMe(GUEST);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
    try {
      if (!sessionStorage.getItem("pt_v")) {
        sessionStorage.setItem("pt_v", "1");
        void fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ k: "visit" }) });
      }
    } catch { /* 无痕模式等 */ }
  }, [refreshMe]);

  return <AppCtx.Provider value={{ prefs, setPrefs, me, refreshMe }}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  return useContext(AppCtx);
}
