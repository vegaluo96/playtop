"use client";

/**
 * 历史报价弹层(移动/桌面共用):某场比赛自归档起的全部报价帧逐条回查。
 * 走势页表格只保留变盘点摘要,这里满足「看全量」的需求;变盘行金色高亮,滚球帧带标。
 */
import { useEffect, useState } from "react";
import { Sheet } from "./ui";
import { useApp } from "./app-context";
import { MarketValue } from "./market-cell";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export interface HistoryTarget {
  id: number;
  mk: "ah" | "ou" | "eu";
  /** 指定书商(对比行点入):bid=bookmaker_id,co=打码名 */
  bid?: number;
  co?: string;
}

const MKS: [HistoryTarget["mk"], string][] = [["ah", "让球"], ["ou", "大小"], ["eu", "胜平负"]];
const COLS: Record<string, string[]> = {
  ah: ["时间", "指数", "主水", "客水"],
  ou: ["时间", "指数", "大水", "小水"],
  eu: ["时间", "主胜", "平局", "客胜"],
};

export function QuoteHistorySheet({ target, onClose }: { target: HistoryTarget | null; onClose: () => void }) {
  const [mk, setMk] = useState<HistoryTarget["mk"]>("ah");
  const [data, setData] = useState<V | null>(null);
  const { prefs } = useApp();

  useEffect(() => {
    if (target) setMk(target.mk);
  }, [target]);
  useEffect(() => {
    if (!target) return;
    setData(null);
    const bk = target.bid ? `&bk=${target.bid}` : "";
    void fetch(`/api/match/${target.id}/history?mk=${mk}&tz=${encodeURIComponent(prefs.tz)}${bk}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => j.ok && setData(j));
  }, [target, mk, prefs.tz]);

  if (!target) return null;
  const grid = mk === "eu" ? "82px 1fr 1fr 1fr" : "82px 1fr 70px 70px";
  return (
    <Sheet open onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>历史报价</span>
        {target.co && (
          <span style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)", background: "var(--selected-bg)", borderRadius: 5, padding: "2px 8px" }}>{target.co}</span>
        )}
        <span style={{ flex: 1 }} />
        {MKS.map(([k, label]) => (
          <span key={k} onClick={() => setMk(k)} style={{ fontSize: 11.5, fontWeight: 700, cursor: "pointer", borderRadius: 7, padding: "3px 10px", background: mk === k ? "var(--selected-bg)" : "var(--inset)", color: mk === k ? "var(--gold)" : "var(--fg-3)" }}>
            {label}
          </span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: grid, padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
        {COLS[mk].map((c, i) => (
          <span key={c} style={{ fontSize: 11, color: "var(--fg-3)", textAlign: i > 0 ? "right" : "left" }}>{c}</span>
        ))}
      </div>
      <div style={{ maxHeight: "52vh", overflowY: "auto" }}>
        {!data && <div style={{ padding: "24px 0", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>加载中…</div>}
        {data && data.rows.length === 0 && <div style={{ padding: "24px 0", textAlign: "center", fontSize: 11, color: "var(--fg-3)" }}>该市场暂无归档报价</div>}
        {(data?.rows ?? []).map((r: V, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: grid, padding: "7px 10px", alignItems: "center", borderBottom: "1px solid var(--line-soft)", background: r.chg ? "var(--selected-bg-soft)" : "transparent" }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", display: "flex", alignItems: "center", gap: 4 }}>
              {r.t}
              {r.live && <span style={{ fontSize: 11, fontWeight: 800, color: "var(--red)", border: "1px solid var(--danger-border)", borderRadius: 3, padding: "0 3px" }}>滚</span>}
            </span>
            {mk === "eu" ? (
              <>
                <MarketValue v={r.h} small style={{ justifyContent: "flex-end" }} />
                <MarketValue v={r.d} small dim style={{ justifyContent: "flex-end" }} />
                <MarketValue v={r.a} small style={{ justifyContent: "flex-end" }} />
              </>
            ) : (
              <>
                <MarketValue v={r.text} className="" small style={{ color: r.chg ? "var(--gold)" : "var(--fg-mid)", justifyContent: "flex-end", fontWeight: 800 }} />
                <MarketValue v={r.h} small style={{ justifyContent: "flex-end" }} />
                <MarketValue v={r.a} small style={{ justifyContent: "flex-end" }} />
              </>
            )}
          </div>
        ))}
      </div>
      {data && (
        <div style={{ fontSize: 11, color: "var(--fg-3)", paddingTop: 8, lineHeight: 1.6 }}>
          共 {data.n} 帧{data.n > 500 ? "(展示最近 500 帧)" : ""} · 自 {data.startAt ?? "—"} 归档起
          {target.bid ? ` · ${target.co ?? data.src ?? ""} 单家赛前序列` : ` · 赛前源 ${data.src ?? "—"};滚球帧来自实时盘归档`}。
        </div>
      )}
    </Sheet>
  );
}
