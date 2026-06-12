"use client";

/** 平台公告条(后台「赛事与内容」发布,上线中即显示):取最新一条,可关闭,关闭记忆到该条 id */
import { useEffect, useState } from "react";
import { useSiteConfig } from "./site-config";

interface Ann {
  id: number;
  text: string;
}

const SEEN_KEY = "playtop.ann.dismissed";

export function AnnouncementBar({ compact = false }: { compact?: boolean }) {
  const [ann, setAnn] = useState<Ann | null>(null);
  const cfg = useSiteConfig();

  useEffect(() => {
    const latest = cfg?.announcements?.[0];
    if (!latest) return;
    const dismissed = Number(localStorage.getItem(SEEN_KEY) ?? 0);
    if (latest.id > dismissed) setAnn(latest);
  }, [cfg]);

  if (!ann) return null;
  const close = () => {
    localStorage.setItem(SEEN_KEY, String(ann.id));
    setAnn(null);
  };
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        padding: compact ? "5px 12px" : "7px 16px",
        background: "var(--selected-bg-soft)", borderBottom: "1px solid var(--selected-border-soft)",
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)", border: "1px solid var(--selected-border)", borderRadius: 4, padding: "1px 6px", flexShrink: 0 }}>公告</span>
      <span style={{ flex: 1, fontSize: compact ? 10.5 : 11, color: "var(--fg-mid)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ann.text}</span>
      <span onClick={close} style={{ flexShrink: 0, fontSize: 12, color: "var(--fg-3)", cursor: "pointer", padding: "0 2px" }}>✕</span>
    </div>
  );
}
