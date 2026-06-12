"use client";

/**
 * 队徽/球员头像(API-SPORTS CDN,URL 由 id 确定):懒加载,加载失败回退首字母/号码圆形,
 * 绝不显示破图。dark 背景下用浅色衬底保证深色队徽可见。
 */
import { useState } from "react";

const CDN = "https://media.api-sports.io/football";

export function TeamLogo({ id, name, size = 18 }: { id?: number | null; name: string; size?: number }) {
  const [err, setErr] = useState(false);
  if (!id || err)
    return (
      <span
        style={{
          width: size, height: size, borderRadius: "50%", flexShrink: 0, display: "inline-flex", alignItems: "center",
          justifyContent: "center", fontSize: size * 0.5, fontWeight: 800, background: "var(--inset)", color: "var(--fg-2)",
        }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${CDN}/teams/${id}.png`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErr(true)}
      alt={name}
      style={{ borderRadius: "50%", objectFit: "contain", flexShrink: 0, background: "var(--inset)", padding: Math.max(1, size * 0.08) }}
    />
  );
}

export function PlayerAvatar({ id, name, num, size = 26, ring }: { id?: number | null; name: string; num?: number | null; size?: number; ring?: string }) {
  const [err, setErr] = useState(false);
  if (!id || err)
    return (
      <span
        className="mono"
        style={{
          width: size, height: size, borderRadius: "50%", flexShrink: 0, display: "inline-flex", alignItems: "center",
          justifyContent: "center", fontSize: size * 0.4, fontWeight: 800, background: ring ?? "var(--inset)", color: "var(--on-accent)",
        }}
      >
        {num ?? name.slice(0, 1)}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${CDN}/players/${id}.png`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErr(true)}
      alt={name}
      style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: ring ? `2px solid ${ring}` : undefined, background: "var(--inset)" }}
    />
  );
}
