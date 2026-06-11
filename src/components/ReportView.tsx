import { minAcceptableOdds } from "@/server/engine/boundary";
import type { EngineOutput } from "@/server/engine/types";
import type { LlmSections } from "@/server/llm/reportWriter";
import { ratingStars, selectionLabel } from "@/server/llm/reportWriter";
import type { MatchDetailView } from "@/server/services/views";
import { versionDelta } from "@/server/services/views";
import { Collapse, MARKET_LABEL, ProbBar, SectionTitle, Tag, fmtCn, pct } from "./ui";

/**
 * 玩家视角的研报正文（解锁/公开态）。
 * 决策卡 10 秒回答三个问题：买什么方向、什么价以下不要、可信度多高；
 * 论据按重要性下沉，模型明细全部收进"专业附录"折叠区供查证。
 */
export default function ReportView({ view }: { view: MatchDetailView }) {
  const engine = view.engine as EngineOutput;
  const sections = view.sections as LlmSections;
  const { stars, verdict } = ratingStars(engine);
  const odds2 = (o: number | null | undefined) => (o == null ? "—" : o.toFixed(2));
  let sec = 0;
  const idx = () => String(++sec).padStart(2, "0");
  // 更新可见性：最近更新时间 + 较上版变化（派生自版本历史，零存储）
  const updatedAt = view.publishedAt ?? engine.computedAt;
  const delta = view.versions.length >= 2 ? versionDelta(view.versions[0], view.versions[1]) : null;
  // 亚盘主盘看板（玩家第一视角）：有亚盘观点时与观点同线（避免"观点一条线、看板另一条线"的表观冲突），
  // 否则取模型赢盘概率最接近五五开的让球线 + 跨家最优水位
  const ahHome = engine.value.filter((v) => v.market === "ah" && v.selection === "home");
  const ahPick = engine.picks.find((p) => p.market === "ah" && p.line !== null);
  const mainAh =
    (ahPick ? ahHome.find((v) => v.line === ahPick.line) : undefined) ??
    (ahHome.length ? ahHome.reduce((b, v) => (Math.abs(v.modelProb - 0.5) < Math.abs(b.modelProb - 0.5) ? v : b)) : null);
  const mainAhAway = mainAh ? engine.value.find((v) => v.market === "ah" && v.line === mainAh.line && v.selection === "away") : null;

  return (
    <div className="pb-8">
      {/* 决策卡：方向 + 边界线 + 评级 + 一句话论点，10 秒看懂 */}
      <div className="card mt-4 p-4">
        <div className="flex items-center justify-between">
          <span className="font-display text-lg tracking-wide text-gold-bright">{stars}</span>
          <Tag tone="gold">第 {view.card.version} 版</Tag>
        </div>
        <div className="tabular mt-1 text-[10px] text-faint">
          更新于 {fmtCn(updatedAt)}
          {delta && (
            <>
              {" "}· 较上版：<span className="text-muted">{delta}</span>
            </>
          )}
        </div>
        {engine.picks.length > 0 ? (
          <>
            <div className="mt-1 text-[15px] font-semibold tracking-wide text-ink">{verdict}</div>
            <p className="mt-2 border-l-2 border-gold/50 pl-3 text-[12px] leading-6 text-ink/85">{sections.thesis}</p>
            <div className="mt-4 overflow-x-auto">
            <table className="tabular w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="text-left text-[10px] tracking-wider text-faint">
                  <th className="pb-1 font-normal">观点</th>
                  <th className="pb-1 text-right font-normal">参考赔率</th>
                  <th className="pb-1 text-right font-normal">最低可接受</th>
                  <th className="pb-1 text-right font-normal">模拟单位</th>
                  <th className="pb-1 text-right font-normal">信心</th>
                </tr>
              </thead>
              <tbody>
                {engine.picks.map((p, i) => {
                  const boundary = minAcceptableOdds(p.modelProb, view.boundaryMargin);
                  return (
                    <tr key={i} className="border-t border-hairline">
                      <td className="py-1.5 text-ink">
                        {MARKET_LABEL[p.market]}·{selectionLabel(p.market, p.selection, p.line)}
                      </td>
                      <td className="py-1.5 text-right">
                        {odds2(p.odds)}
                        {p.bookmaker && <span className="ml-1 text-[9px] text-faint">{p.bookmaker}</span>}
                      </td>
                      <td className="py-1.5 text-right font-semibold text-gold-bright">{boundary > 0 ? boundary.toFixed(2) : "—"}</td>
                      <td className="py-1.5 text-right">{p.kelly ? pct(p.kelly) : "—"}</td>
                      <td className="py-1.5 text-right text-gold-bright">{p.confidence}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-faint">
              <b className="text-ink">最低可接受赔率</b>：本观点的价格边界——你看到的实际价格低于该值时，观点即失去参考价值
              （开赛锁定时若收盘价低于边界，按观望处理、不计入战绩）。模拟单位：¼ Kelly 风险刻度（上限
              5%），仅为风险量化展示。
            </p>
            {mainAh && (
              <div className="tabular mt-3 rounded border border-gold/25 bg-gold/5 px-3 py-2 text-[11px]">
                <span className="text-[10px] tracking-wider text-faint">亚盘主盘</span>{" "}
                <b className="text-ink">{selectionLabel("ah", "home", mainAh.line)}</b>
                <span className="ml-2 text-muted">
                  主 {mainAh.odds.toFixed(2)}
                  {mainAh.bookmaker ? `（${mainAh.bookmaker}）` : ""}
                  {mainAhAway ? ` / 客 ${mainAhAway.odds.toFixed(2)}${mainAhAway.bookmaker ? `（${mainAhAway.bookmaker}）` : ""}` : ""}
                </span>
                <span className="ml-2">
                  模型主赢盘 <b className="text-gold-bright">{pct(mainAh.modelProb)}</b>
                </span>
              </div>
            )}
            <div className="mt-3">
              <ProbBar home={engine.ensemble.probs.home} draw={engine.ensemble.probs.draw} away={engine.ensemble.probs.away} />
            </div>
          </>
        ) : (
          <>
            <div className="mt-3 rounded border border-hairline bg-overlay/50 px-3 py-2 text-[11px] text-muted">
              本场结论：<b className="text-ink">观望</b>——模型认为当前所有价格都不值得参与（观望场次不计入战绩分母）。
            </div>
            <p className="mt-2 border-l-2 border-hairline pl-3 text-[12px] leading-6 text-ink/85">{sections.thesis}</p>
            {mainAh && (
              <div className="tabular mt-3 rounded border border-hairline bg-overlay/40 px-3 py-2 text-[11px]">
                <span className="text-[10px] tracking-wider text-faint">亚盘主盘</span>{" "}
                <b className="text-ink">{selectionLabel("ah", "home", mainAh.line)}</b>
                <span className="ml-2 text-muted">
                  主 {mainAh.odds.toFixed(2)}
                  {mainAhAway ? ` / 客 ${mainAhAway.odds.toFixed(2)}` : ""}
                </span>
                <span className="ml-2 text-muted">
                  模型主赢盘 <b className="text-ink">{pct(mainAh.modelProb)}</b>
                </span>
              </div>
            )}
            <div className="mt-3">
              <ProbBar home={engine.ensemble.probs.home} draw={engine.ensemble.probs.draw} away={engine.ensemble.probs.away} />
            </div>
          </>
        )}
      </div>

      {/* 价差监测：锐价真值锚 vs 各家报价——"这个价相对真值贵还是便宜、哪家在让利" */}
      {engine.spread && engine.spread.deviations.length > 0 && (
        <div className="card mt-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-[13px] tracking-wider text-ink">价差监测</h2>
            <span className="text-[10px] text-faint">
              真值锚：{engine.spread.anchor.source === "sharp" ? `锐价（${engine.spread.anchor.books.join("、")}）` : "加权共识"}
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
          <table className="tabular w-full min-w-[420px] text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-wider text-faint">
                <th className="pb-1 font-normal">盘口来源</th>
                <th className="pb-1 font-normal">方向</th>
                <th className="pb-1 text-right font-normal">报价</th>
                <th className="pb-1 text-right font-normal">锚定公允</th>
                <th className="pb-1 text-right font-normal">概率偏离</th>
              </tr>
            </thead>
            <tbody>
              {engine.spread.deviations.slice(0, 10).map((d, i) => (
                <tr key={i} className="border-t border-hairline">
                  <td className="py-1.5">{d.bookmaker}</td>
                  <td className="py-1.5">{MARKET_LABEL[d.market]}·{selectionLabel(d.market, d.selection, d.line)}</td>
                  <td className="py-1.5 text-right">{d.odds.toFixed(2)}</td>
                  <td className="py-1.5 text-right text-muted">{d.fairOdds.toFixed(2)}</td>
                  <td className={`py-1.5 text-right ${d.deviationPct > 0 ? "text-up" : "text-down/80"}`}>
                    {d.deviationPct >= 0 ? "+" : ""}
                    {pct(d.deviationPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {engine.spread.inefficiencyIndex !== null && (
            <p className="tabular mt-2 text-[10.5px] text-muted">
              跨家组合隐含概率 <b className={engine.spread.inefficiencyIndex < 1 ? "text-up" : "text-ink"}>{pct(engine.spread.inefficiencyIndex)}</b>
              {engine.spread.inefficiencyIndex < 1 && " —— 市场出现定价失效现象"}
            </p>
          )}
          <p className="mt-2 text-[10px] leading-4 text-faint">
            正偏离 = 该来源报价高于锐价锚定的公允价（滞后让利现象）。本表为市场效率研究信号，仅反映各来源定价差异，不构成任何参与建议。
          </p>
        </div>
      )}

      <SectionTitle index={idx()}>关键驱动因素</SectionTitle>
      <ul className="space-y-2 text-[12.5px] leading-6 text-ink/85">
        {sections.drivers.map((d, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-gold">▸</span>
            <span>{d}</span>
          </li>
        ))}
      </ul>

      {sections.tactics && (
        <>
          <SectionTitle index={idx()}>战术对位</SectionTitle>
          <p className="report-prose text-[12.5px] leading-7 text-ink/85">{sections.tactics}</p>
        </>
      )}

      {sections.marketView && (
        <>
          <SectionTitle index={idx()}>市场叙事</SectionTitle>
          <p className="report-prose text-[12.5px] leading-7 text-ink/85">{sections.marketView}</p>
        </>
      )}

      {engine.dixonColes && (
        <>
          <SectionTitle index={idx()}>最可能比分</SectionTitle>
          <div className="tabular flex flex-wrap gap-2">
            {engine.dixonColes.topScores.map((s) => (
              <div key={s.score} className="card px-3 py-2 text-center">
                <div className="font-display text-base text-gold-bright">{s.score}</div>
                <div className="text-[10px] text-muted">{pct(s.prob)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle index={idx()}>风险提示</SectionTitle>
      <ul className="space-y-2 text-[12px] leading-6 text-muted">
        {(sections.scenarios ?? []).map((s, i) => (
          <li key={`sc-${i}`} className="flex gap-2">
            <span className="text-info">◇</span>
            <span>
              <b className="text-ink">情景：</b>
              {s}
            </span>
          </li>
        ))}
        {sections.risks.map((r, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-down">⚠</span>
            <span>{r}</span>
          </li>
        ))}
        <li className="flex gap-2">
          <span className="text-down">⚠</span>
          <span>收盘前盘口仍可能显著移动；本报告随数据持续改版，以开赛前最后一版为战绩结算口径。</span>
        </li>
        <li className="flex gap-2">
          <span className="text-down">⚠</span>
          <span>
            全部概率与结算均为 <b className="text-ink">90 分钟常规时间口径</b>（不含加时与点球）；赔率参照多来源，价值口径取跨家最优价，不同渠道实际成交价格可能不同。
          </span>
        </li>
      </ul>

      {/* —— 专业附录：全部模型明细与底层数据，供进阶读者与查证使用 —— */}
      <SectionTitle index={idx()}>专业附录</SectionTitle>
      <p className="-mt-1 mb-2 text-[10.5px] leading-4 text-faint">
        以下为模型明细与全部底层数据——结论如何算出来、依据是什么，每一项都可展开查证。
      </p>

      <Collapse title="模型结果与集成权重" hint="市场去水 / Dixon-Coles / Elo 三路印证">
        <table className="tabular w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] tracking-wider text-faint">
              <th className="pb-1 font-normal">信息源</th>
              <th className="pb-1 text-right font-normal">主胜</th>
              <th className="pb-1 text-right font-normal">平局</th>
              <th className="pb-1 text-right font-normal">客胜</th>
              <th className="pb-1 text-right font-normal">权重</th>
            </tr>
          </thead>
          <tbody>
            {engine.market?.books.map((b) => (
              <tr key={b.bookmaker} className="border-t border-hairline text-muted">
                <td className="py-1.5">「{b.bookmaker}」Shin 去水（水位 {pct(b.overround)}）</td>
                <td className="py-1.5 text-right">{pct(b.devigged.home)}</td>
                <td className="py-1.5 text-right">{pct(b.devigged.draw)}</td>
                <td className="py-1.5 text-right">{pct(b.devigged.away)}</td>
                <td className="py-1.5 text-right">—</td>
              </tr>
            ))}
            {engine.market && (
              <tr className="border-t border-hairline">
                <td className="py-1.5">市场加权共识（{engine.market.books.length > 1 ? `${engine.market.books.length} 家` : "Shin 去水"}）</td>
                <td className="py-1.5 text-right">{pct(engine.market.devigged.home)}</td>
                <td className="py-1.5 text-right">{pct(engine.market.devigged.draw)}</td>
                <td className="py-1.5 text-right">{pct(engine.market.devigged.away)}</td>
                <td className="py-1.5 text-right text-muted">{pct(engine.ensemble.weights.market)}</td>
              </tr>
            )}
            {engine.dixonColes && (
              <tr className="border-t border-hairline">
                <td className="py-1.5">Dixon-Coles 双泊松</td>
                <td className="py-1.5 text-right">{pct(engine.dixonColes.probs.home)}</td>
                <td className="py-1.5 text-right">{pct(engine.dixonColes.probs.draw)}</td>
                <td className="py-1.5 text-right">{pct(engine.dixonColes.probs.away)}</td>
                <td className="py-1.5 text-right text-muted">{pct(engine.ensemble.weights.dc)}</td>
              </tr>
            )}
            {engine.elo && (
              <tr className="border-t border-hairline">
                <td className="py-1.5">
                  进球差调整 Elo（{engine.elo.home.toFixed(0)} vs {engine.elo.away.toFixed(0)}）
                </td>
                <td className="py-1.5 text-right">{pct(engine.elo.probs.home)}</td>
                <td className="py-1.5 text-right">{pct(engine.elo.probs.draw)}</td>
                <td className="py-1.5 text-right">{pct(engine.elo.probs.away)}</td>
                <td className="py-1.5 text-right text-muted">{pct(engine.ensemble.weights.elo)}</td>
              </tr>
            )}
            <tr className="border-t border-gold/30 font-semibold text-gold-bright">
              <td className="py-1.5">集成（对数意见池）</td>
              <td className="py-1.5 text-right">{pct(engine.ensemble.probs.home)}</td>
              <td className="py-1.5 text-right">{pct(engine.ensemble.probs.draw)}</td>
              <td className="py-1.5 text-right">{pct(engine.ensemble.probs.away)}</td>
              <td className="py-1.5 text-right">—</td>
            </tr>
          </tbody>
        </table>
        {engine.dixonColes && (
          <p className="tabular mt-2 text-[10px] text-faint">
            λ={engine.dixonColes.lambda.toFixed(3)} · μ={engine.dixonColes.mu.toFixed(3)} · ρ=
            {engine.dixonColes.rho.toFixed(3)} · γ={engine.dixonColes.gamma.toFixed(3)} · 退化等级 L{engine.fallbackLevel}
          </p>
        )}
      </Collapse>

      {(engine.markets.ou.length > 0 || engine.markets.ah.length > 0) && (
        <Collapse title="衍生市场概率" hint="大小球 / 亚盘全盘口">
          <div className="grid grid-cols-2 gap-2">
            {engine.markets.ou.length > 0 && (
              <table className="tabular w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] tracking-wider text-faint">
                    <th className="pb-1 font-normal">大小球</th>
                    <th className="pb-1 text-right font-normal">大</th>
                    <th className="pb-1 text-right font-normal">小</th>
                  </tr>
                </thead>
                <tbody>
                  {engine.markets.ou.map((o) => (
                    <tr key={o.line} className="border-t border-hairline">
                      <td className="py-1.5">{o.line}</td>
                      <td className="py-1.5 text-right">{pct(o.over)}</td>
                      <td className="py-1.5 text-right">{pct(o.under)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {engine.markets.ah.length > 0 && (
              <table className="tabular w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] tracking-wider text-faint">
                    <th className="pb-1 font-normal">亚盘（主让）</th>
                    <th className="pb-1 text-right font-normal">主赢盘</th>
                    <th className="pb-1 text-right font-normal">客赢盘</th>
                  </tr>
                </thead>
                <tbody>
                  {engine.markets.ah.map((a) => (
                    <tr key={a.line} className="border-t border-hairline">
                      <td className="py-1.5">{a.line > 0 ? `+${a.line}` : a.line}</td>
                      <td className="py-1.5 text-right">{pct(a.homeCover)}</td>
                      <td className="py-1.5 text-right">{pct(a.awayCover)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Collapse>
      )}

      {engine.scoreMarket.length > 0 && (
        <Collapse title="比分市场对照" hint={`波胆去水 vs 模型分布（${engine.scoreMarket[0].bookmaker}）`}>
          <p className="mb-2 text-[11px] leading-5 text-muted">
            市场（波胆赔率 power 去水）与模型（Dixon-Coles 比分分布）对每个具体比分的定价对照——分歧即研究信号。
          </p>
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-wider text-faint">
                <th className="pb-1 font-normal">比分</th>
                <th className="pb-1 text-right font-normal">市场赔率</th>
                <th className="pb-1 text-right font-normal">市场概率</th>
                <th className="pb-1 text-right font-normal">模型概率</th>
                <th className="pb-1 text-right font-normal">分歧</th>
              </tr>
            </thead>
            <tbody>
              {engine.scoreMarket.map((s) => {
                const diff = s.modelProb - s.marketProb;
                return (
                  <tr key={s.score} className="border-t border-hairline">
                    <td className="py-1.5">{s.score}</td>
                    <td className="py-1.5 text-right">{s.odds.toFixed(2)}</td>
                    <td className="py-1.5 text-right">{pct(s.marketProb)}</td>
                    <td className="py-1.5 text-right">{pct(s.modelProb)}</td>
                    <td className={`py-1.5 text-right ${diff > 0.01 ? "text-up" : diff < -0.01 ? "text-down" : "text-muted"}`}>
                      {diff >= 0 ? "+" : ""}
                      {pct(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Collapse>
      )}

      {engine.value.length > 0 && (
        <Collapse title="价值扫描全表" hint="所有可评估点位的期望收益与模拟单位">
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-wider text-faint">
                <th className="pb-1 font-normal">点位</th>
                <th className="pb-1 text-right font-normal">赔率</th>
                <th className="pb-1 text-right font-normal">模型概率</th>
                <th className="pb-1 text-right font-normal">期望收益</th>
                <th className="pb-1 text-right font-normal">模拟单位</th>
              </tr>
            </thead>
            <tbody>
              {[...engine.value]
                .sort((a, b) => b.ev - a.ev)
                .slice(0, 8)
                .map((v, i) => (
                  <tr key={i} className="border-t border-hairline">
                    <td className="py-1.5">
                      {MARKET_LABEL[v.market]}·{selectionLabel(v.market, v.selection, v.line)}
                    </td>
                    <td className="py-1.5 text-right">{v.odds.toFixed(2)}</td>
                    <td className="py-1.5 text-right">{pct(v.modelProb)}</td>
                    <td className={`py-1.5 text-right ${v.ev > 0 ? "text-up" : "text-down/80"}`}>
                      {v.ev >= 0 ? "+" : ""}
                      {pct(v.ev)}
                    </td>
                    <td className="py-1.5 text-right">{v.kelly > 0 ? pct(v.kelly) : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Collapse>
      )}

      {engine.oddsMovement.length >= 2 && (
        <Collapse title="盘口异动记录" hint={`${engine.oddsMovement.length} 次采样（1X2）`}>
          <p className="mb-2 text-[10.5px] leading-4 text-faint">异动请按同一来源纵向对比——不同来源之间的价差属于价差监测口径，不是异动。</p>
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[420px] text-[11px]">
              <thead>
                <tr className="text-left text-[10px] tracking-wider text-faint">
                  <th className="pb-1 font-normal">采集时间</th>
                  <th className="pb-1 font-normal">来源</th>
                  <th className="pb-1 text-right font-normal">主胜</th>
                  <th className="pb-1 text-right font-normal">平局</th>
                  <th className="pb-1 text-right font-normal">客胜</th>
                </tr>
              </thead>
              <tbody>
                {engine.oddsMovement.slice(-10).map((o, i) =>
                  o.oneXTwo ? (
                    <tr key={i} className="border-t border-hairline">
                      <td className="py-1.5 text-muted">{fmtCn(o.capturedAt)}</td>
                      <td className="py-1.5 text-faint">{o.bookmaker ?? "—"}</td>
                      <td className="py-1.5 text-right">{o.oneXTwo.home.toFixed(2)}</td>
                      <td className="py-1.5 text-right">{o.oneXTwo.draw.toFixed(2)}</td>
                      <td className="py-1.5 text-right">{o.oneXTwo.away.toFixed(2)}</td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          </div>
        </Collapse>
      )}

      <Collapse
        title="数据基础与完备度"
        hint={`${view.snapshots.total} 份快照 · ${view.snapshots.perKind.length} 个维度${view.snapshots.missing.length > 0 ? "（部分缺失）" : ""}`}
      >
        <p className="text-[11.5px] leading-5 text-muted">
          本场累计采集 <b className="text-gold-bright">{view.snapshots.total}</b> 份数据快照，覆盖{" "}
          <b className="text-gold-bright">{view.snapshots.perKind.length}</b> 个维度
          {view.snapshots.missing.length > 0 ? "（部分维度缺失，已反映在置信度中）" : "，全维度齐备"}。
        </p>
        <table className="tabular mt-2 w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] tracking-wider text-faint">
              <th className="pb-1 font-normal">维度</th>
              <th className="pb-1 font-normal">来源</th>
              <th className="pb-1 text-right font-normal">采集次数</th>
              <th className="pb-1 text-right font-normal">最近采集</th>
            </tr>
          </thead>
          <tbody>
            {view.snapshots.perKind.map((s) => (
              <tr key={s.kind} className="border-t border-hairline">
                <td className="py-1.5">{s.kindLabel}</td>
                <td className="py-1.5 text-muted">{s.source}</td>
                <td className="py-1.5 text-right">{s.count}</td>
                <td className="py-1.5 text-right text-muted">{fmtCn(s.fetchedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapse>

      {view.versions.length > 1 && (
        <Collapse title="更新记录" hint={`${view.versions.length} 个版本 · 每版改了什么`}>
          <p className="mb-2 text-[11px] leading-5 text-muted">
            赛前观点随盘口/阵容/天气持续重算改版，每一版都哈希存证、赛后可验——这里是完整的演化轨迹。
          </p>
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-wider text-faint">
                <th className="pb-1 font-normal">版本</th>
                <th className="pb-1 font-normal">发布于</th>
                <th className="pb-1 font-normal">较上版变化</th>
                <th className="pb-1 text-right font-normal">主胜</th>
                <th className="pb-1 text-right font-normal">平局</th>
                <th className="pb-1 text-right font-normal">客胜</th>
              </tr>
            </thead>
            <tbody>
              {view.versions.map((v, i) => {
                const prev = view.versions[i + 1];
                return (
                  <tr key={v.version} className="border-t border-hairline">
                    <td className="py-1.5">V{v.version}</td>
                    <td className="py-1.5 text-muted">{fmtCn(v.publishedAt ?? v.createdAt)}</td>
                    <td className="py-1.5 text-muted">{prev ? versionDelta(v, prev) : "首版发布"}</td>
                    <td className="py-1.5 text-right">{pct(v.ensemble.home)}</td>
                    <td className="py-1.5 text-right">{pct(v.ensemble.draw)}</td>
                    <td className="py-1.5 text-right">{pct(v.ensemble.away)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Collapse>
      )}

      <Collapse title="计算过程审计轨迹" hint={`${engine.trace.length} 条，逐步可查`}>
        <ul className="space-y-1 border-l border-hairline pl-3 text-[10.5px] leading-5 text-muted">
          {engine.trace.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </Collapse>

      <Collapse title="方法论与学术文献" hint="全部方法均经同行评审">
        <ul className="space-y-1.5 border-l border-hairline pl-3 text-[10.5px] leading-5 text-muted">
          <li>Dixon &amp; Coles (1997). Modelling Association Football Scores and Inefficiencies in the Football Betting Market. JRSS-C 46(2).</li>
          <li>Hvattum &amp; Arntzen (2010). Using ELO ratings for match result prediction in association football. IJF 26(3).</li>
          <li>Shin (1993). Measuring the Incidence of Insider Trading in a Market for State-Contingent Claims. EJ 103(420)；Štrumbelj (2014). IJF 30(4).</li>
          <li>Wheatcroft (2020). A profitable model for predicting the over/under market in football. IJF 36(3).</li>
          <li>Genest &amp; Zidek (1986). Combining Probability Distributions. Statistical Science 1(1)；Kelly (1956). BSTJ 35(4).</li>
        </ul>
      </Collapse>

      <p className="mt-6 border-t border-hairline pt-3 text-[10px] leading-5 text-faint">
        免责声明：本报告由确定性量化模型生成，AI 仅参与文字措辞（数字白名单校验），引擎版本 {engine.modelVersion}。
        内容仅供研究参考，不构成任何投注建议。足球比赛具有高度不确定性，请理性看待概率、自负风险。
      </p>
    </div>
  );
}
