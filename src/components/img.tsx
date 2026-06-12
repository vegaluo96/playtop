"use client";

/**
 * 队徽/球员头像(远端图片或官方返回 URL):懒加载,加载失败回退首字母/号码圆形,
 * 绝不显示破图。dark 背景下用浅色衬底保证深色队徽可见。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";

const CDN = "https://media.api-sports.io/football";

export function TeamLogo({ id, name, size = 18, src }: { id?: number | null; name: string; size?: number; src?: string | null }) {
  const [err, setErr] = useState(false);
  const imgSrc = useMemo(() => src || (id ? `${CDN}/teams/${id}.png` : ""), [id, src]);
  useEffect(() => setErr(false), [imgSrc]);

  const frame: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    boxSizing: "border-box",
    border: "1px solid var(--line-soft)",
    background: "var(--inset)",
  };
  if (!imgSrc || err)
    return (
      <span
        data-team-logo
        aria-label={name}
        style={{
          ...frame,
          fontSize: size * 0.5,
          fontWeight: 800,
          color: "var(--fg-2)",
        }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    <span data-team-logo aria-label={name} style={frame} title={name}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imgSrc}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setErr(true)}
        alt={name}
        style={{ display: "block", width: "82%", height: "82%", objectFit: "contain", borderRadius: Math.max(2, size * 0.12) }}
      />
    </span>
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
