import type { CSSProperties } from "react";

export const MOVE_FILTERS = ["全部", "滚球", "升盘", "降盘", "水位"];
export type MoveDirection = "up" | "down" | "flat";

export function moveDirectionFromDelta(delta: number | null | undefined): MoveDirection {
  return delta == null || delta === 0 ? "flat" : delta > 0 ? "up" : "down";
}

export function moveDirectionColor(direction: MoveDirection | string | null | undefined): string {
  return direction === "up" ? "var(--up)" : direction === "down" ? "var(--down)" : "var(--fg-2)";
}

export function moveTypeColor(t: string, direction?: MoveDirection | string | null): string {
  if (t === "升盘") return "var(--up)";
  if (t === "降盘") return "var(--down)";
  if (t === "水位") return moveDirectionColor(direction);
  return "var(--fg-2)";
}

export function moveCardStyle(compact = false): CSSProperties {
  return {
    background: "var(--card)",
    border: `1px solid ${compact ? "var(--line-soft)" : "var(--line)"}`,
    borderRadius: compact ? 9 : 12,
    marginBottom: compact ? 6 : 8,
    padding: compact ? "8px 10px" : "10px 12px",
    cursor: "pointer",
  };
}

export function moveTitleStyle(compact = false): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    fontSize: compact ? 11.5 : 13.5,
    lineHeight: 1.25,
    fontWeight: 800,
    color: "var(--fg)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

export function moveTimeStyle(compact = false): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: compact ? 11 : 11.5,
    lineHeight: 1,
    fontWeight: 650,
    color: "var(--fg-3)",
    fontVariantNumeric: "tabular-nums",
  };
}

export function movePillStyle(tone: "neutral" | "muted" | "danger" | "live" = "neutral", compact = false, maxWidth?: number): CSSProperties {
  const isDanger = tone === "danger";
  const isLive = tone === "live";
  return {
    flexShrink: 0,
    maxWidth,
    minHeight: compact ? 18 : 20,
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
    padding: compact ? "1px 6px" : "2px 7px",
    background: isDanger ? "var(--danger-bg)" : isLive ? "var(--danger-bg-soft)" : "var(--inset)",
    border: `1px solid ${isDanger ? "var(--danger-border)" : isLive ? "var(--danger-border)" : "transparent"}`,
    color: isDanger || isLive ? "var(--red)" : tone === "muted" ? "var(--fg-3)" : "var(--fg-2)",
    fontSize: compact ? 11 : 11.5,
    lineHeight: 1,
    fontWeight: 780,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

export function moveTypeStyle(type: string, compact = false, direction?: MoveDirection | string | null): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: compact ? 11.5 : 12,
    lineHeight: 1,
    fontWeight: 800,
    color: moveTypeColor(type, direction),
    whiteSpace: "nowrap",
  };
}

export function moveArrowStyle(type: string, compact = false, direction?: MoveDirection | string | null): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: compact ? 11.5 : 12,
    color: moveTypeColor(type, direction),
    lineHeight: 1,
  };
}

export function moveNoteStyle(compact = false, maxWidth?: number): CSSProperties {
  return {
    minWidth: 0,
    maxWidth,
    fontSize: compact ? 11 : 11.5,
    lineHeight: 1.35,
    color: "var(--fg-3)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

export const moveValueFromStyle: CSSProperties = { justifyContent: "flex-start", color: "var(--fg-2)" };

export function moveValueToStyle(type: string, direction?: MoveDirection | string | null): CSSProperties {
  return { justifyContent: "flex-start", color: moveTypeColor(type, direction), fontWeight: 800 };
}

export function moveWaterValueStyle(direction?: MoveDirection | string | null): CSSProperties {
  return { justifyContent: "flex-start", color: moveDirectionColor(direction), fontWeight: 800 };
}
