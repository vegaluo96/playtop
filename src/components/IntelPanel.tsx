import type { MatchIntel } from "@/server/services/views";
import { Collapse, fmtCn } from "./ui";

/**
 * 比赛情报面板：把抓取到的全部维度结构化亮给玩家——
 * 首发/伤停/交锋/状态/积分榜/射手/裁判/教练/外部评级/天气/舆情。
 * 每块只在有数据时渲染；这正是"完备度计数"背后的内容本体。
 */
export default function IntelPanel({ intel, homeName, awayName }: { intel: MatchIntel; homeName: string; awayName: string }) {
  const teamName = (t: "home" | "away") => (t === "home" ? homeName : awayName);
  const inj = [...(intel.injuries?.items ?? []), ...(intel.suspensions?.items ?? []).map((i) => ({ ...i, status: i.status || "停赛" }))];
  const hasLineups = !!intel.lineups && (intel.lineups.home.starters.length > 0 || intel.lineups.away.starters.length > 0);
  const scorers = (intel.playerStats?.items ?? []).filter((p) => (p.goals ?? 0) > 0).slice(0, 8);
  const misc: { label: string; value: string }[] = [];
  if (intel.referee?.name) misc.push({ label: "主裁判", value: `${intel.referee.name}${intel.referee.note ? `（${intel.referee.note}）` : ""}` });
  if (intel.coach?.home.name || intel.coach?.away.name) {
    misc.push({ label: "主教练", value: `${homeName} ${intel.coach?.home.name || "未知"} / ${awayName} ${intel.coach?.away.name || "未知"}` });
  }
  if (intel.weather?.summary) misc.push({ label: "开球时段天气", value: intel.weather.summary });
  for (const s of intel.softInfo?.items ?? []) misc.push({ label: s.topic, value: s.content });

  if (!hasLineups && inj.length === 0 && !intel.h2h?.summary.total && !intel.form && !intel.standings && !intel.teamStats && scorers.length === 0 && misc.length === 0) {
    return null;
  }

  return (
    <>
      {hasLineups && intel.lineups && (
        <Collapse
          title={intel.lineups.confirmed ? "官方首发阵容" : "预计阵容（未经官方确认）"}
          hint={`${intel.lineups.home.formation ?? "—"} vs ${intel.lineups.away.formation ?? "—"}`}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(["home", "away"] as const).map((side) => {
              const l = intel.lineups![side];
              return (
                <div key={side}>
                  <div className="text-[11px] font-semibold text-ink">
                    {teamName(side)} {l.formation && <span className="tabular ml-1 text-[10px] text-gold-bright">{l.formation}</span>}
                  </div>
                  <ul className="mt-1.5 space-y-0.5 text-[11px] leading-5 text-muted">
                    {l.starters.slice(0, 11).map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                    {l.starters.length === 0 && <li className="text-faint">未公布</li>}
                  </ul>
                </div>
              );
            })}
          </div>
          {intel.lineups.note && <p className="mt-2 text-[10px] text-faint">{intel.lineups.note}</p>}
        </Collapse>
      )}

      {inj.length > 0 && (
        <Collapse title="伤停与停赛" hint={`${inj.length} 人`}>
          <ul className="space-y-1 text-[11.5px] leading-5">
            {inj.map((i, idx) => (
              <li key={idx} className="flex items-baseline gap-2">
                <span className="shrink-0 text-[10px] text-faint">{teamName(i.team)}</span>
                <span className="text-ink">{i.player}</span>
                <span className="text-[10px] text-down">{i.status || "缺阵"}</span>
                {i.note && <span className="text-[10px] text-faint">{i.note}</span>}
              </li>
            ))}
          </ul>
        </Collapse>
      )}

      {(intel.h2h?.summary.total ?? 0) > 0 && intel.h2h && (
        <Collapse
          title="历史交锋"
          hint={`近 ${intel.h2h.summary.total} 场：${homeName} ${intel.h2h.summary.homeWins}胜 ${intel.h2h.summary.draws}平 ${intel.h2h.summary.awayWins}负`}
        >
          <table className="tabular w-full text-[11px]">
            <tbody>
              {intel.h2h.matches.slice(0, 8).map((m, i) => (
                <tr key={i} className="border-t border-hairline">
                  <td className="py-1.5 text-faint">{fmtCn(m.playedAt)}</td>
                  <td className="py-1.5 text-muted">
                    {m.homeTeam} <b className="text-ink">{m.homeGoals}:{m.awayGoals}</b> {m.awayTeam}
                  </td>
                  <td className="py-1.5 text-right text-faint">{m.competition ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapse>
      )}

      {intel.form && (
        <Collapse title="近期状态" hint="两队最近赛果">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(["home", "away"] as const).map((side) => {
              const f = intel.form![side];
              return (
                <div key={side}>
                  <div className="text-[11px] font-semibold text-ink">{teamName(side)}</div>
                  <p className="mt-1 text-[11px] leading-5 text-muted">{f.summaryText}</p>
                  <ul className="tabular mt-1.5 space-y-0.5 text-[10.5px] text-faint">
                    {f.recent.slice(0, 5).map((r, i) => {
                      const res = r.goalsFor > r.goalsAgainst ? "胜" : r.goalsFor === r.goalsAgainst ? "平" : "负";
                      const tone = res === "胜" ? "text-up" : res === "负" ? "text-down" : "text-muted";
                      const extra = [
                        r.xg !== undefined ? `xG ${r.xg.toFixed(1)}` : null,
                        r.shots !== undefined ? `射${r.shots}${r.shotsOnTarget !== undefined ? `/${r.shotsOnTarget}` : ""}` : null,
                        r.possession !== undefined ? `控${r.possession}%` : null,
                      ].filter(Boolean).join(" · ");
                      return (
                        <li key={i}>
                          <span className={`${tone} font-semibold`}>{res}</span> {r.goalsFor}:{r.goalsAgainst} vs {r.opponent}
                          {extra && <span className="ml-1 text-faint/80">（{extra}）</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </Collapse>
      )}

      {intel.teamStats && (
        <Collapse title="球队赛季数据" hint="胜平负 · 攻防 · 点球 · 连胜">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(["home", "away"] as const).map((side) => {
              const s = intel.teamStats![side];
              const rows: { label: string; value: string }[] = [
                { label: "赛季战绩", value: s.wins !== undefined ? `${s.wins}胜 ${s.draws}平 ${s.loses}负（${s.matches} 场）` : `${s.matches} 场` },
                { label: "场均进/失", value: `${s.gfPerGame.toFixed(2)} / ${s.gaPerGame.toFixed(2)}` },
                { label: "零封率", value: `${(s.cleanSheetRate * 100).toFixed(0)}%` },
                ...(s.failedToScoreRate !== undefined ? [{ label: "未进球率", value: `${(s.failedToScoreRate * 100).toFixed(0)}%` }] : []),
                ...(s.winStreak ? [{ label: "最长连胜", value: `${s.winStreak} 场` }] : []),
                ...(s.penaltyTotal ? [{ label: "点球", value: `${s.penaltyScored ?? 0}/${s.penaltyTotal}` }] : []),
                ...(s.biggestWin ? [{ label: "最大胜", value: s.biggestWin }] : []),
                ...(s.formation ? [{ label: "常用阵型", value: s.formation }] : []),
              ];
              return (
                <div key={side}>
                  <div className="text-[11px] font-semibold text-ink">
                    {teamName(side)} {s.form && <span className="tabular ml-1 text-[10px] text-gold-bright">{s.form}</span>}
                  </div>
                  <ul className="tabular mt-1 space-y-0.5 text-[10.5px] leading-5">
                    {rows.map((r, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="text-faint">{r.label}</span>
                        <span className="text-muted">{r.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Collapse>
      )}

      {intel.standings && intel.standings.table.length > 0 && (
        <Collapse title="积分榜" hint={intel.standings.note || `${intel.standings.table.length} 队`}>
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-wider text-faint">
                <th className="pb-1 font-normal">#</th>
                <th className="pb-1 font-normal">球队</th>
                <th className="pb-1 text-right font-normal">赛</th>
                <th className="pb-1 text-right font-normal">净胜</th>
                <th className="pb-1 text-right font-normal">积分</th>
              </tr>
            </thead>
            <tbody>
              {intel.standings.table.map((r) => {
                const mine = r.rank === intel.standings!.homeRank || r.rank === intel.standings!.awayRank;
                return (
                  <tr key={`${r.rank}-${r.team}`} className={`border-t border-hairline ${mine ? "font-semibold text-gold-bright" : ""}`}>
                    <td className="py-1">{r.rank}</td>
                    <td className="py-1">{r.team}</td>
                    <td className="py-1 text-right">{r.played}</td>
                    <td className="py-1 text-right">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                    <td className="py-1 text-right">{r.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Collapse>
      )}

      {scorers.length > 0 && (
        <Collapse title="射手与关键球员" hint={`${scorers.length} 人`}>
          <ul className="space-y-1 text-[11.5px] leading-5">
            {scorers.map((p, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="shrink-0 text-[10px] text-faint">{teamName(p.team)}</span>
                <span className="text-ink">{p.player}</span>
                {p.goals !== undefined && <span className="tabular text-[10px] text-gold-bright">{p.goals} 球</span>}
                {p.note && <span className="text-[10px] text-faint">{p.note}</span>}
              </li>
            ))}
          </ul>
          {(intel.playerStats?.notes ?? []).map((n, i) => (
            <p key={i} className="mt-1.5 text-[10.5px] leading-4 text-muted">
              {n}
            </p>
          ))}
        </Collapse>
      )}

      {(intel.externalRatings?.items.length ?? 0) > 0 && (
        <Collapse title="外部评级互证" hint="独立第三方评级">
          <ul className="tabular space-y-1 text-[11.5px] leading-5">
            {intel.externalRatings!.items.map((r, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="shrink-0 text-[10px] text-faint">{teamName(r.team)}</span>
                <span className="text-muted">{r.source}</span>
                <span className="font-semibold text-ink">{r.rating}</span>
                {r.rank != null && <span className="text-[10px] text-faint">第 {r.rank} 位</span>}
                {r.note && <span className="text-[10px] text-faint">{r.note}</span>}
              </li>
            ))}
          </ul>
        </Collapse>
      )}

      {misc.length > 0 && (
        <Collapse title="裁判 · 教练 · 天气 · 舆情" hint={`${misc.length} 条`}>
          <ul className="space-y-1.5 text-[11.5px] leading-5">
            {misc.map((m, i) => (
              <li key={i}>
                <span className="text-[10px] tracking-wider text-faint">{m.label}</span>{" "}
                <span className="text-muted">{m.value}</span>
              </li>
            ))}
          </ul>
        </Collapse>
      )}
    </>
  );
}
