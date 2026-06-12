"use client";

/**
 * 自选关注(类自选股):游客存 localStorage,登录存账户(/api/watch);
 * 登录后首次加载自动把本地关注合并到账户。列表中关注场次置顶分组。
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";

const LS_KEY = "playtop.watch";

function readLocal(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => Number.isFinite(x)) : [];
  } catch {
    return [];
  }
}
function writeLocal(ids: number[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ids.slice(0, 100)));
  } catch {
    /* 存储不可用时仅会话内生效 */
  }
}

export function useWatchlist(loggedIn: boolean): { ids: Set<number>; toggle: (id: number) => void } {
  const [ids, setIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!loggedIn) {
      setIds(new Set(readLocal()));
      return;
    }
    // 登录:本地合并到账户(一次)→ 拉账户列表
    void (async () => {
      const local = readLocal();
      if (local.length > 0) {
        await fetch("/api/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: local }) }).catch(() => {});
        writeLocal([]);
      }
      const j = await fetch("/api/watch", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (j?.ok) setIds(new Set(j.ids as number[]));
    })();
  }, [loggedIn]);

  const toggle = useCallback(
    (id: number) => {
      setIds((prev) => {
        const next = new Set(prev);
        const on = !next.has(id);
        if (on) next.add(id);
        else next.delete(id);
        if (loggedIn) {
          void fetch("/api/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, on }) }).catch(() => {});
        } else {
          writeLocal([...next]);
        }
        return next;
      });
    },
    [loggedIn],
  );
  return { ids, toggle };
}

/** 星标(点击切换,自动阻断冒泡防触发行点击) */
export function WatchStar({ on, onToggle, size = 14, style }: { on: boolean; onToggle: () => void; size?: number; style?: CSSProperties }) {
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={on ? "取消关注" : "加入关注"}
      style={{ flexShrink: 0, width: size + 10, height: size + 10, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: size, lineHeight: 1, color: on ? "var(--gold)" : "var(--fg-4)", ...style }}
    >
      {on ? "★" : "☆"}
    </span>
  );
}
