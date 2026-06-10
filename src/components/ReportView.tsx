import type { EngineOutput } from "@/server/engine/types";
import type { LlmSections } from "@/server/llm/reportWriter";
import { ratingStars, selectionLabel } from "@/server/llm/reportWriter";
import type { MatchDetailView } from "@/server/services/views";
import { MARKET_LABEL, ProbBar, SectionTitle, Tag, fmtCn, pct } from "./ui";

/** 投行风格研报正文（解锁/公开态） */
export default function ReportView({ view }: { view: MatchDetailView }) {
  const engine = view.engine as EngineOutput;
  const sections = view.sections as LlmSections;
  const { stars, verdict } = ratingStars(engine);
  const odds2 = (o: number | null | undefined) => (o == null ? "—" : o.toFixed(2));

  return (
    <div className="pb-8">
      {/* 摘要卡 */}
      <div className="card mt-4 p-4">
        <div className="flex items-center justify-between">
          <span className="font-display text-lg tracking-[0.2em] text-gold-bright">{stars}</span>
          <Tag tone="gold">第 {view.card.version} 版</Tag>
        </div>
        <div className="mt-1 text-[13px] text-ink">{verdict}</div>
        <div className="mt-4">
          <ProbBar home={engine.ensemble.probs.home} draw={engine.ensemble.probs.draw} away={engine.ensemble.probs.away} />
        </div>
        {engine.picks.length > 0 ? (
          <table className="tabular mt-4 w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-widest text-faint">
                <th className="pb-1 font-normal">研究观点</th>
                <th className="pb-1 text-right font-normal">模型概率</th>
                <th className="pb-1 text-right font-normal">赔率</th>
                <th className="pb-1 text-right font-normal">EV</th>
                <th className="pb-1 text-right font-normal">¼Kelly</th>
                <th className="pb-1 text-right font-normal">置信</th>
              </tr>
            </thead>
            <tbody>
              {engine.picks.map((p, i) => (
                <tr key={i} className="border-t border-hairline">
                  <td className="py-1.5 text-ink">
                    {MARKET_LABEL[p.market]}·{selectionLabel(p.market, p.selection, p.line)}
                  </td>
                  <td className="py-1.5 text-right">{pct(p.modelProb)}</td>
                  <td className="py-1.5 text-right">{odds2(p.odds)}</td>
                  <td className={`py-1.5 text-right ${p.ev !== null && p.ev > 0 ? "text-up" : "text-muted"}`}>
                    {p.ev === null ? "—" : `${p.ev >= 0 ? "+" : ""}${pct(p.ev)}`}
                  </td>
                  <td className="py-1.5 text-right">{p.kelly ? pct(p.kelly) : "—"}</td>
                  <td className="py-1.5 text-right text-gold-bright">{p.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="mt-3 rounded border border-hairline bg-overlay/50 px-3 py-2 text-[11px] text-muted">
            本场结论：<b className="text-ink">观望</b>——所有点位期望值不足以覆盖水位成本（观望场次不计入战绩分母）。
          </div>
        )}
      </div>

      <SectionTitle index="01">核心论点</SectionTitle>
      <p className="report-prose border-l-2 border-gold/50 pl-3 text-[13px] leading-7 text-ink/90">{sections.thesis}</p>

      <SectionTitle index="02">关键驱动因素</SectionTitle>
      <ul className="space-y-2 text-[12.5px] leading-6 text-ink/85">
        {sections.drivers.map((d, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-gold">▸</span>
            <span>{d}</span>
          </li>
        ))}
      </ul>

      <SectionTitle index="03">模型结果</SectionTitle>
      <table className="tabular w-full text-[11px]">
        <thead>
          <tr className="text-left text-[10px] tracking-widest text-faint">
            <th className="pb-1 font-normal">信息源</th>
            <th className="pb-1 text-right font-normal">主胜</th>
            <th className="pb-1 text-right font-normal">平局</th>
            <th className="pb-1 text-right font-normal">客胜</th>
            <th className="pb-1 text-right font-normal">权重</th>
          </tr>
        </thead>
        <tbody>
          {engine.market && (
            <tr className="border-t border-hairline">
              <td className="py-1.5">市场（Shin 去水，水位 {pct(engine.market.overround)}）</td>
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
        <>
          <SectionTitle index="04">比分分布</SectionTitle>
          <div className="tabular flex flex-wrap gap-2">
            {engine.dixonColes.topScores.map((s) => (
              <div key={s.score} className="card px-3 py-2 text-center">
                <div className="font-display text-base text-gold-bright">{s.score}</div>
                <div className="text-[10px] text-muted">{pct(s.prob)}</div>
              </div>
            ))}
          </div>
          <p className="tabular mt-2 text-[10px] text-faint">
            λ={engine.dixonColes.lambda.toFixed(3)} · μ={engine.dixonColes.mu.toFixed(3)} · ρ=
            {engine.dixonColes.rho.toFixed(3)} · γ={engine.dixonColes.gamma.toFixed(3)} · 退化等级 L{engine.fallbackLevel}
          </p>
        </>
      )}

      {(engine.markets.ou.length > 0 || engine.markets.ah.length > 0) && (
        <>
          <SectionTitle index="05">衍生市场</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            {engine.markets.ou.length > 0 && (
              <table className="tabular w-full text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] tracking-widest text-faint">
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
                  <tr className="text-left text-[10px] tracking-widest text-faint">
                    <th className="pb-1 font-normal">亚盘</th>
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
        </>
      )}

      {engine.value.length > 0 && (
        <>
          <SectionTitle index="06">价值扫描（EV 与 ¼ Kelly 仓位）</SectionTitle>
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-widest text-faint">
                <th className="pb-1 font-normal">点位</th>
                <th className="pb-1 text-right font-normal">赔率</th>
                <th className="pb-1 text-right font-normal">模型概率</th>
                <th className="pb-1 text-right font-normal">EV</th>
                <th className="pb-1 text-right font-normal">仓位</th>
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
        </>
      )}

      {engine.oddsMovement.length >= 2 && (
        <>
          <SectionTitle index="07">盘口异动（1X2）</SectionTitle>
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-widest text-faint">
                <th className="pb-1 font-normal">采集时间</th>
                <th className="pb-1 text-right font-normal">主胜</th>
                <th className="pb-1 text-right font-normal">平局</th>
                <th className="pb-1 text-right font-normal">客胜</th>
              </tr>
            </thead>
            <tbody>
              {engine.oddsMovement.slice(-8).map((o, i) =>
                o.oneXTwo ? (
                  <tr key={i} className="border-t border-hairline">
                    <td className="py-1.5 text-muted">{fmtCn(o.capturedAt)}</td>
                    <td className="py-1.5 text-right">{o.oneXTwo.home.toFixed(2)}</td>
                    <td className="py-1.5 text-right">{o.oneXTwo.draw.toFixed(2)}</td>
                    <td className="py-1.5 text-right">{o.oneXTwo.away.toFixed(2)}</td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
        </>
      )}

      <SectionTitle index="08">数据基础与完备度</SectionTitle>
      <p className="text-[11.5px] leading-5 text-muted">
        本场累计采集 <b className="text-gold-bright">{view.snapshots.total}</b> 份数据快照，覆盖{" "}
        <b className="text-gold-bright">{view.snapshots.perKind.length}</b> 个维度
        {view.snapshots.missing.length > 0 ? "（部分维度缺失，已反映在置信度中）" : "，全维度齐备"}。
      </p>
      <table className="tabular mt-2 w-full text-[11px]">
        <thead>
          <tr className="text-left text-[10px] tracking-widest text-faint">
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

      <SectionTitle index="09">风险提示</SectionTitle>
      <ul className="space-y-2 text-[12px] leading-6 text-muted">
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
            全部概率与结算均为 <b className="text-ink">90 分钟常规时间口径</b>（不含加时与点球）；赔率为单一参考来源，不同渠道实际成交价格可能不同。
          </span>
        </li>
      </ul>

      {view.versions.length > 1 && (
        <>
          <SectionTitle index="10">版本演化</SectionTitle>
          <table className="tabular w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] tracking-widest text-faint">
                <th className="pb-1 font-normal">版本</th>
                <th className="pb-1 text-right font-normal">主胜</th>
                <th className="pb-1 text-right font-normal">平局</th>
                <th className="pb-1 text-right font-normal">客胜</th>
                <th className="pb-1 text-right font-normal">发布于</th>
              </tr>
            </thead>
            <tbody>
              {view.versions.map((v) => (
                <tr key={v.version} className="border-t border-hairline">
                  <td className="py-1.5">V{v.version}</td>
                  <td className="py-1.5 text-right">{pct(v.ensemble.home)}</td>
                  <td className="py-1.5 text-right">{pct(v.ensemble.draw)}</td>
                  <td className="py-1.5 text-right">{pct(v.ensemble.away)}</td>
                  <td className="py-1.5 text-right text-muted">{v.publishedAt ? fmtCn(v.publishedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <details className="mt-7">
        <summary className="cursor-pointer text-[11px] tracking-widest text-faint">
          ▸ 计算过程审计轨迹（{engine.trace.length} 条）
        </summary>
        <ul className="mt-2 space-y-1 border-l border-hairline pl-3 text-[10.5px] leading-5 text-muted">
          {engine.trace.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </details>

      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] tracking-widest text-faint">▸ 方法论与学术文献</summary>
        <ul className="mt-2 space-y-1.5 border-l border-hairline pl-3 text-[10.5px] leading-5 text-muted">
          <li>Dixon &amp; Coles (1997). Modelling Association Football Scores and Inefficiencies in the Football Betting Market. JRSS-C 46(2).</li>
          <li>Hvattum &amp; Arntzen (2010). Using ELO ratings for match result prediction in association football. IJF 26(3).</li>
          <li>Shin (1993). Measuring the Incidence of Insider Trading in a Market for State-Contingent Claims. EJ 103(420)；Štrumbelj (2014). IJF 30(4).</li>
          <li>Wheatcroft (2020). A profitable model for predicting the over/under market in football. IJF 36(3).</li>
          <li>Genest &amp; Zidek (1986). Combining Probability Distributions. Statistical Science 1(1)；Kelly (1956). BSTJ 35(4).</li>
        </ul>
      </details>

      <p className="mt-6 border-t border-hairline pt-3 text-[10px] leading-5 text-faint">
        免责声明：本报告由确定性量化模型生成，AI 仅参与文字措辞（数字白名单校验），引擎版本 {engine.modelVersion}。
        内容仅供研究参考，不构成任何投注建议。足球比赛具有高度不确定性，请理性看待概率、自负风险。
      </p>
    </div>
  );
}
