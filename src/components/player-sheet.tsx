"use client";

/** 球员资料弹层(双端共用):头像 + 基本信息 + 赛季统计 + 伤停/停赛史(players + sidelined 端点) */
import { useEffect, useState } from "react";
import { PlayerAvatar } from "./img";
import { Sheet } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type V = any;

export interface PlayerTarget {
  id: number;
  name: string;
  season: number;
}

/* 会话级缓存:同一球员二次点开零等待 */
const cache = new Map<string, V>();

export function PlayerSheet({ target, onClose }: { target: PlayerTarget | null; onClose: () => void }) {
  const [v, setV] = useState<V | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setErr("");
    if (!target) {
      setV(null);
      return;
    }
    const key = `${target.id}:${target.season}`;
    const hit = cache.get(key);
    if (hit) {
      setV(hit); // 缓存命中即开即显
      return;
    }
    setV(null);
    fetch(`/api/player/${target.id}?season=${target.season}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          cache.set(key, j);
          setV(j);
        } else setErr(j.error || "暂无数据");
      })
      .catch(() => setErr("网络异常"));
  }, [target]);

  return (
    <Sheet open={!!target} onClose={onClose} z={80}>
      {target && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <PlayerAvatar id={target.id} name={target.name} size={52} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>{v?.name ?? target.name}</div>
              <div style={{ fontSize: 10.5, color: "var(--fg-2)", marginTop: 3 }}>
                {v ? [v.stats?.[0]?.pos, v.age ? `${v.age} 岁` : null, v.nationality, v.height].filter(Boolean).join(" · ") : err || "加载中…"}
              </div>
            </div>
            {v?.injured && (
              <span style={{ fontSize: 9, fontWeight: 800, color: "var(--red)", background: "rgba(240,67,79,.14)", borderRadius: 4, padding: "2px 7px", flexShrink: 0 }}>伤停中</span>
            )}
          </div>

          {!v && !err && (
            <div style={{ background: "var(--inset)", borderRadius: 10, padding: "12px", marginBottom: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 6 }}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} style={{ height: 30, borderRadius: 6, background: "var(--line)", opacity: 0.5, animation: "livepulse 1.4s infinite" }} />
                ))}
              </div>
            </div>
          )}
          {v?.stats?.length > 0 && (
            <>
              {v.stats.map((st: V, i: number) => (
                <div key={i} style={{ background: "var(--inset)", borderRadius: 10, padding: "9px 12px", marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--fg-3)", marginBottom: 7 }}>{st.league} · {st.team}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 4, textAlign: "center" }}>
                    {[[st.apps, "出场"], [st.goals, "进球"], [st.assists, "助攻"], [st.yellow, "黄牌"], [st.red, "红牌"], [st.rating ?? "—", "评分"]].map(([n, label]) => (
                      <div key={label as string}>
                        <div className="mono" style={{ fontSize: 13, fontWeight: 800, color: label === "评分" ? "var(--gold)" : "var(--fg)" }}>{n as string}</div>
                        <div style={{ fontSize: 8.5, color: "var(--fg-3)", marginTop: 1 }}>{label as string}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {v?.sidelined?.length > 0 && (
            <div style={{ background: "var(--inset)", borderRadius: 10, padding: "9px 12px" }}>
              <div style={{ fontSize: 10, color: "var(--fg-3)", marginBottom: 6 }}>伤停 / 停赛史</div>
              {v.sidelined.map((sd: V, i: number) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: i < v.sidelined.length - 1 ? "1px solid var(--line-soft)" : "none" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg-mid)", flex: 1 }}>{sd.type}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>{sd.from} ~ {sd.to}</span>
                </div>
              ))}
            </div>
          )}
          {v && !v.stats?.length && !v.sidelined?.length && (
            <div style={{ textAlign: "center", fontSize: 11, color: "var(--fg-3)", padding: "14px 0" }}>该球员本赛季暂无统计数据</div>
          )}
        </>
      )}
    </Sheet>
  );
}
