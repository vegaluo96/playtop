import Link from "next/link";
import { Collapse, MARKET_LABEL, SectionTitle, Stat, Tag, fmtCn, pct } from "@/components/ui";
import { selectionLabel } from "@/server/llm/reportWriter";
import { calibrationStats, recordList, recordOverview } from "@/server/services/stats";

export const dynamic = "force-dynamic";

const PERIODS: { label: string; days: number | null }[] = [
  { label: "近 30 天", days: 30 },
  { label: "近 90 天", days: 90 },
  { label: "全部", days: null },
];

export default async function RecordPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const period = PERIODS.find((x) => String(x.days) === p) ?? PERIODS[2];
  const overview = recordOverview(period.days);
  const rows = recordList(120);
  const calibration = calibrationStats();

  return (
    <div className="py-4">
      <h1 className="font-display text-lg tracking-wide">战绩档案</h1>
      <p className="mt-1 text-[11px] leading-5 text-muted">
        全部数据由不可变的链上记录实时计算：预测在开赛瞬间锁定，赛后自动比对官方赛果，无任何人工修饰空间。
      </p>

      <div className="mt-3 flex gap-2">
        {PERIODS.map((x) => (
          <Link
            key={x.label}
            href={`/record?p=${x.days}`}
            className={`rounded-full border px-3 py-1 text-[11px] ${
              x.label === period.label ? "border-gold/60 text-gold-bright" : "border-hairline text-muted"
            }`}
          >
            {x.label}
          </Link>
        ))}
      </div>

      <p className="mt-3 text-[10.5px] leading-5 text-faint">
        <b className="text-ink">怎么读这三个数</b>：平注 ROI 是每注 1 单位的真实盈亏；命中率短期受运气影响大；
        <b className="text-ink">收盘价值（CLV）</b>是我们锁定的价格相对收盘价的平均优势——长期为正说明判断持续快于市场，
        这是衡量长期能力最硬的指标。
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        {overview.map((m) => (
          <div key={m.market} className="card px-3.5 py-3">
            <div className="flex items-center justify-between">
              <span className="font-display text-[13px] tracking-wider text-ink">{MARKET_LABEL[m.market]}</span>
              <Tag>{m.n} 个观点</Tag>
            </div>
            {m.hitRate !== null ? (
              <div className="tabular mt-2 grid grid-cols-4 gap-2 text-center">
                <div>
                  <div className={`text-lg font-semibold ${m.roi !== null && m.roi >= 0 ? "text-up" : "text-down"}`}>
                    {m.roi === null ? "—" : `${m.roi >= 0 ? "+" : ""}${pct(m.roi)}`}
                  </div>
                  <div className="text-[9px] tracking-wider text-faint">平注 ROI</div>
                </div>
                <div>
                  <div className="text-lg font-semibold text-gold-bright">{pct(m.hitRate)}</div>
                  <div className="text-[9px] tracking-wider text-faint">命中率</div>
                </div>
                <div>
                  <div className="text-lg font-semibold text-ink">
                    {m.hits}-{m.misses}
                    {m.pushes > 0 ? `-${m.pushes}` : ""}
                  </div>
                  <div className="text-[9px] tracking-wider text-faint">胜-负{m.pushes > 0 ? "-走" : ""}</div>
                </div>
                <div>
                  <div className={`text-lg font-semibold ${m.avgClv !== null && m.avgClv >= 0 ? "text-up" : "text-muted"}`}>
                    {m.avgClv === null ? "—" : `${m.avgClv >= 0 ? "+" : ""}${pct(m.avgClv)}`}
                  </div>
                  <div className="text-[9px] tracking-wider text-faint">收盘价值 CLV</div>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-faint">样本积累中</p>
            )}
            {m.wilsonLow !== null && m.wilsonHigh !== null && m.hits + m.misses >= 5 && (
              <p className="tabular mt-2 text-[10px] text-faint">
                命中率 95% 置信区间：{pct(m.wilsonLow)} – {pct(m.wilsonHigh)}（样本 {m.hits + m.misses}，Wilson 法）
              </p>
            )}
          </div>
        ))}
      </div>

      {calibration.n >= 5 && calibration.model && (
        <div className="mt-5">
          <Collapse title="概率校准（专业自检）" hint={`模型 vs 市场基线 · ${calibration.n} 场`}>
            <p className="mb-2 text-[11px] leading-5 text-muted">
              回答一个问题：<b className="text-ink">模型报出的概率本身准不准？</b>
              用 RPS 评分对照去水收盘价（业内公认最强基线），分数越低越准。
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="模型 RPS"
                value={calibration.model.rps.toFixed(4)}
                sub={`对数损失 ${calibration.model.logLoss.toFixed(4)}`}
                accent
              />
              <Stat
                label="市场基线 RPS"
                value={calibration.market ? calibration.market.rps.toFixed(4) : "—"}
                sub={calibration.market ? `对数损失 ${calibration.market.logLoss.toFixed(4)}` : ""}
              />
            </div>
            <p className="mt-2 text-[10px] leading-4 text-faint">
              RPS：Ranked Probability Score（Constantinou &amp; Fenton 2012）。
            </p>
          </Collapse>
        </div>
      )}

      <SectionTitle>逐场流水</SectionTitle>
      {rows.length === 0 ? (
        <div className="card px-4 py-8 text-center text-sm text-muted">暂无已结算观点。</div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {rows.map((r, i) => (
            <Link key={i} href={`/matches/${r.matchId}`} className="card block px-3.5 py-2.5">
              <div className="flex items-center justify-between text-[10px] text-faint">
                <span className="tabular">{fmtCn(r.kickoffAt)}</span>
                <span className="tabular">
                  赛果 {r.homeGoals}:{r.awayGoals}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="truncate text-[13px]">
                    {r.homeName} <span className="text-faint">vs</span> {r.awayName}
                  </div>
                  <div className="tabular mt-0.5 text-[11px] text-muted">
                    {MARKET_LABEL[r.market]}·{selectionLabel(r.market, r.selection, r.line)}
                    {r.oddsAtPublish ? ` @${r.oddsAtPublish.toFixed(2)}` : ""}
                    {r.closingOdds ? ` → 收盘 ${r.closingOdds.toFixed(2)}` : ""}（模型 {pct(r.modelProb)}）
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-right">
                  {r.result === "hit" && <Tag tone="up">命中</Tag>}
                  {r.result === "miss" && <Tag tone="down">未中</Tag>}
                  {r.result === "push" && <Tag>走水</Tag>}
                  {r.pnl !== null && (
                    <div className={`tabular mt-1 text-[11px] ${r.pnl >= 0 ? "text-up" : "text-down"}`}>
                      {r.pnl >= 0 ? "+" : ""}
                      {r.pnl.toFixed(2)}u
                    </div>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="card mt-6 px-3.5 py-3 text-[10.5px] leading-5 text-muted">
        <b className="text-ink">统计口径（公开承诺）：</b>
        ① 预测在开赛瞬间锁定为终版并写入哈希链，赛后不可修改；② 观望场次不进入分母；③ 亚盘赢半计命中、输半计未中、整体走水不计分母，ROI
        按真实拆腿规则逐注计算；④ CLV 为锁定赔率相对收盘赔率的平均偏差；⑤ 比赛腰斩/延期作废退款、不计战绩；⑥
        开赛锁定时若收盘价已低于该观点的最低可接受赔率，该观点按观望处理、不计入胜负与 ROI（审计日志可查）。
      </div>
    </div>
  );
}
