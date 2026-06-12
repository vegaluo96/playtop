"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet, SheetTitle } from "./ui";

export interface SearchItem {
  id: string | number;
  title: string;
  subtitle?: string;
  meta?: string;
  badge?: string;
  href?: string;
  keywords?: (string | number | null | undefined)[];
  onSelect?: () => void;
}

function norm(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function SearchIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="8.5" cy="8.5" r="5.2" />
      <path d="M12.4 12.4 16 16" />
    </svg>
  );
}

export function SearchAction({
  title,
  placeholder,
  hint,
  items,
  emptyText = "没有匹配结果",
}: {
  title: string;
  placeholder: string;
  hint: string;
  items: SearchItem[];
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [open]);

  const results = useMemo(() => {
    const query = norm(q);
    const pool = query
      ? items.filter((it) => {
          const hay = norm([it.title, it.subtitle, it.meta, it.badge, ...(it.keywords ?? [])].filter(Boolean).join(" "));
          return hay.includes(query);
        })
      : items;
    return pool.slice(0, 24);
  }, [items, q]);

  const close = () => {
    setOpen(false);
    setQ("");
  };

  return (
    <>
      <button
        type="button"
        aria-label={title}
        title={title}
        onClick={() => setOpen(true)}
        style={{
          width: 34,
          height: 34,
          border: "1px solid var(--line)",
          borderRadius: 999,
          background: "var(--card)",
          color: "var(--fg-1)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <SearchIcon />
      </button>
      <Sheet open={open} onClose={close} z={70}>
        <SheetTitle title={title} hint={hint} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--inset)", border: "1px solid var(--line)", borderRadius: 10, padding: "9px 10px", marginBottom: 10 }}>
          <SearchIcon size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 0,
              background: "transparent",
              color: "var(--fg-1)",
              fontSize: 13,
              fontWeight: 650,
            }}
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label="清空搜索"
              style={{ border: 0, background: "transparent", color: "var(--fg-3)", fontSize: 18, lineHeight: 1, cursor: "pointer", padding: 0 }}
            >
              ×
            </button>
          )}
        </div>
        <div style={{ maxHeight: "52vh", overflowY: "auto", paddingBottom: 2 }}>
          {results.length === 0 && (
            <div style={{ color: "var(--fg-3)", fontSize: 12, textAlign: "center", padding: "24px 8px" }}>
              {items.length === 0 ? "当前页面暂无可搜索数据" : emptyText}
            </div>
          )}
          {results.map((it) => (
            <div
              key={it.id}
              onClick={() => {
                close();
                if (it.onSelect) it.onSelect();
                else if (it.href) router.push(it.href);
              }}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px", borderBottom: "1px solid var(--line-soft)", cursor: "pointer" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                {(it.subtitle || it.meta) && (
                  <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {[it.subtitle, it.meta].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {it.badge && (
                <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: "var(--fg-2)", background: "var(--inset)", borderRadius: 5, padding: "3px 7px" }}>{it.badge}</span>
              )}
              <span style={{ color: "var(--fg-3)", fontSize: 15, flexShrink: 0 }}>›</span>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
