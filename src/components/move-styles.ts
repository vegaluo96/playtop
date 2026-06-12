import type { CSSProperties } from "react";

export const MOVE_FILTERS = ["全部", "滚球", "升盘", "降盘", "水位"];

export function moveTypeColor(t: string): string {
  return t === "升盘" ? "var(--up)" : t === "降盘" ? "var(--down)" : "var(--accent)";
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

export function movePillStyle(tone: "neutral" | "muted" | "danger" = "neutral", compact = false, maxWidth?: number): CSSProperties {
  const isDanger = tone === "danger";
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
    background: isDanger ? "var(--danger-bg)" : "var(--inset)",
    color: isDanger ? "var(--red)" : tone === "muted" ? "var(--fg-3)" : "var(--fg-2)",
    fontSize: compact ? 11 : 11.5,
    lineHeight: 1,
    fontWeight: 780,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

export function moveTypeStyle(type: string, compact = false): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: compact ? 11.5 : 12,
    lineHeight: 1,
    fontWeight: 800,
    color: moveTypeColor(type),
    whiteSpace: "nowrap",
  };
}

export function moveArrowStyle(type: string, compact = false): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: compact ? 11.5 : 12,
    color: moveTypeColor(type),
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

export function moveValueToStyle(type: string): CSSProperties {
  return { justifyContent: "flex-start", color: moveTypeColor(type), fontWeight: 800 };
}
