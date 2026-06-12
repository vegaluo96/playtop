"use client";

import type { CSSProperties } from "react";
import { f2 } from "@/lib/format";
import { Flash, agoText } from "./live";

export interface MarketCellData {
  text?: string;
  h?: number;
  a?: number;
  d?: number | null;
  hd?: number;
  ad?: number;
  line?: number | null;
  chgAt?: number | null;
}

type MarketKind = "ah" | "ou" | "eu";
type MarketStatus = "open" | "masked" | "empty" | "suspended" | "stale";

const MARKET_NAME: Record<MarketKind, string> = { ah: "让球", ou: "大小", eu: "胜平负" };
const MASK = "-.--";
const VALUE_ROW_HEIGHT = 21;
const MIDDLE_ROW_HEIGHT = 18;
const VALUE_FONT_SIZE = 15;
const VALUE_FONT_WEIGHT = 800;
const MIDDLE_ROW_FONT_SIZE = 12.5;
const MIDDLE_ROW_FONT_WEIGHT = 760;
const SMALL_VALUE_FONT_SIZE = 12.5;
const SMALL_VALUE_FONT_WEIGHT = 760;

function statusOf(cell: MarketCellData | null | undefined, masked: boolean, status?: MarketStatus): MarketStatus {
  if (status) return status;
  if (masked) return "masked";
  if (!cell) return "empty";
  return "open";
}

export function MarketValue({
  v,
  dir,
  masked = false,
  pulse,
  small = false,
  dim = false,
  style,
  className = "mono",
}: {
  v?: string | number | null;
  dir?: number | null;
  masked?: boolean;
  pulse?: number | null;
  small?: boolean;
  dim?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const { justifyContent, ...valueStyle } = style ?? {};
  const rowHeight = small ? MIDDLE_ROW_HEIGHT : VALUE_ROW_HEIGHT;
  return (
    <div style={{ height: rowHeight, minHeight: rowHeight, display: "flex", alignItems: "center", justifyContent: justifyContent ?? "center" }}>
      <Flash
        v={masked || v == null || v === "" ? MASK : typeof v === "number" ? f2(v) : v}
        arrow={!masked && v != null && dir != null && dir !== 0}
        pulse={masked ? null : pulse}
        pulseDir={dir ?? undefined}
        className={className}
        style={{
          fontSize: small ? SMALL_VALUE_FONT_SIZE : VALUE_FONT_SIZE,
          lineHeight: 1,
          letterSpacing: 0,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          fontWeight: small ? SMALL_VALUE_FONT_WEIGHT : VALUE_FONT_WEIGHT,
          color: dim ? "var(--fg-2)" : undefined,
          ...valueStyle,
        }}
      />
    </div>
  );
}

export function MarketCell({
  kind,
  cell,
  masked = false,
  status,
  style,
}: {
  kind: MarketKind;
  cell: MarketCellData | null | undefined;
  masked?: boolean;
  status?: MarketStatus;
  style?: CSSProperties;
}) {
  const st = statusOf(cell, masked, status);
  const dim = st === "empty" || st === "suspended" || st === "stale";
  const title =
    st === "masked"
      ? `${MARKET_NAME[kind]} · 登录可见`
      : st === "empty"
        ? `${MARKET_NAME[kind]} · 暂无指数`
        : st === "suspended"
          ? `${MARKET_NAME[kind]} · 封盘`
          : st === "stale"
            ? `${MARKET_NAME[kind]} · 数据延迟`
            : `${MARKET_NAME[kind]} · 最近变化 ${agoText(cell?.chgAt)}`;

  const wrap: CSSProperties = {
    background: "var(--inset)",
    border: `1px solid ${st === "stale" ? "var(--warn-border)" : "transparent"}`,
    borderRadius: 8,
    padding: "4px 0",
    opacity: dim ? 0.68 : 1,
    minWidth: 0,
    boxSizing: "border-box",
    ...style,
  };

  if (kind === "eu") {
    const vals = [cell?.h, cell?.d, cell?.a];
    const dirs = [cell?.hd, 0, cell?.ad];
    return (
      <div title={title} data-market-kind={kind} data-market-status={st} style={wrap}>
        {vals.map((v, i) => (
          <MarketValue
            key={i}
            v={v ?? undefined}
            dir={dirs[i] ?? undefined}
            masked={masked || st === "masked"}
            pulse={cell?.chgAt}
            small={i === 1}
            style={i === 1 ? { fontSize: MIDDLE_ROW_FONT_SIZE, fontWeight: MIDDLE_ROW_FONT_WEIGHT, color: "var(--fg-2)" } : undefined}
          />
        ))}
      </div>
    );
  }

  const line = masked || st === "masked" ? "●●" : st === "empty" ? "暂无" : st === "suspended" ? "封盘" : (cell?.text ?? "—");
  return (
    <div title={title} data-market-kind={kind} data-market-status={st} style={wrap}>
      <MarketValue v={cell?.h} dir={cell?.hd} masked={masked || st === "masked"} pulse={cell?.chgAt} />
      <div
        className={kind === "ou" ? "mono" : undefined}
        style={{
          height: MIDDLE_ROW_HEIGHT,
          minHeight: MIDDLE_ROW_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: MIDDLE_ROW_FONT_SIZE,
          fontWeight: MIDDLE_ROW_FONT_WEIGHT,
          lineHeight: 1,
          letterSpacing: 0,
          color: st === "empty" ? "var(--fg-3)" : "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <Flash v={line} pulse={masked ? null : cell?.chgAt} style={{ lineHeight: 1, fontVariantNumeric: "tabular-nums" }} />
      </div>
      <MarketValue v={cell?.a} dir={cell?.ad} masked={masked || st === "masked"} pulse={cell?.chgAt} />
    </div>
  );
}
