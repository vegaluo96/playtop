import Link from "next/link";
import { count } from "drizzle-orm";
import { db } from "@/server/db";
import { dataSnapshots, historyMatches } from "@/server/db/schema";
import { currentUser } from "@/server/auth/guards";
import { listMatchCards, UPCOMING_STATUSES, type MatchCard } from "@/server/services/views";
import { recordSummary } from "@/server/services/stats";
import { Stat, fmtDateCn, pct } from "@/components/ui";
import MatchCardRow from "@/components/MatchCardRow";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await currentUser();
  const cards = listMatchCards(user?.id ?? null);
  const snapshotCount = db.select({ n: count() }).from(dataSnapshots).get()?.n ?? 0;
  const historyCount = db.select({ n: count() }).from(historyMatches).get()?.n ?? 0;
  const summary = recordSummary(30);

  // 玩家动线：有观点可看的场次在前（按日分组），"研报准备中"沉底
  const active = cards.filter((c) => !(UPCOMING_STATUSES as readonly string[]).includes(c.status));
  const upcoming = cards.filter((c) => (UPCOMING_STATUSES as readonly string[]).includes(c.status));
  const groups = new Map<string, MatchCard[]>();
  for (const c of active) {
    const key = fmtDateCn(c.kickoffAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  return (
    <div className="py-4">
      {/* 信任条：玩家第一眼要的是"你们到底准不准"——真数据，逐场可验 */}
      <Link href="/record" className="card block border-gold/25 px-3.5 py-3">
        <div className="flex items-center justify-between">
          <span className="font-display text-[12px] tracking-wider text-ink">近 30 天战绩（逐场可验）</span>
          <span className="text-[10px] text-gold-bright">战绩档案 →</span>
        </div>
        {summary.decisive >= 5 ? (
          <div className="tabular mt-2 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className={`text-lg font-semibold ${summary.roi !== null && summary.roi >= 0 ? "text-up" : "text-down"}`}>
                {summary.roi === null ? "—" : `${summary.roi >= 0 ? "+" : ""}${pct(summary.roi)}`}
              </div>
              <div className="text-[9px] tracking-wider text-faint">平注 ROI</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-ink">{summary.hitRate === null ? "—" : pct(summary.hitRate)}</div>
              <div className="text-[9px] tracking-wider text-faint">命中率（{summary.decisive} 个观点）</div>
            </div>
            <div>
              <div className={`text-lg font-semibold ${summary.avgClv !== null && summary.avgClv >= 0 ? "text-up" : "text-muted"}`}>
                {summary.avgClv === null ? "—" : `${summary.avgClv >= 0 ? "+" : ""}${pct(summary.avgClv)}`}
              </div>
              <div className="text-[9px] tracking-wider text-faint">收盘价值 CLV</div>
            </div>
          </div>
        ) : (
          <p className="mt-1.5 text-[11px] leading-5 text-muted">
            战绩样本积累中——每条观点开赛锁定、赛后公开、观望也计入档案，我们无法美化过去。
          </p>
        )}
      </Link>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="历史样本库" value={historyCount.toLocaleString()} sub="场赛果驱动模型" />
        <Stat label="累计数据快照" value={snapshotCount.toLocaleString()} sub="实时采集中" accent />
        <Stat label="覆盖赛事" value={cards.length} sub="赛后全部免费公开" />
      </div>

      <p className="mt-4 rounded-lg border border-gold/20 bg-gold/5 px-3 py-2 text-[11px] leading-5 text-muted">
        每条观点给出<b className="text-gold-bright">方向与最低可接受赔率</b>（价格边界线）——拿你看到的实际价格一对照即可；
        数字全部由量化模型计算（AI 不参与任何计算），赛前自动改版、开赛锁定存证、赛后免费公开。
      </p>

      {cards.length === 0 && (
        <div className="card mt-6 px-4 py-10 text-center text-sm text-muted">
          暂无已发布赛事研报，请稍后再来。
        </div>
      )}

      {[...groups.entries()].map(([date, list]) => (
        <section key={date} className="mt-5">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="font-display text-[13px] tracking-wide text-muted">{date}</h2>
            <div className="gold-rule flex-1" />
          </div>
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {list.map((c) => (
              <Link key={c.id} href={`/matches/${c.id}`} className="block">
                <MatchCardRow card={c} />
              </Link>
            ))}
          </div>
        </section>
      ))}

      {upcoming.length > 0 && (
        <section className="mt-6">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="font-display text-[13px] tracking-wide text-faint">即将覆盖 · 研报准备中</h2>
            <div className="gold-rule flex-1" />
          </div>
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {upcoming.map((c) => (
              <Link key={c.id} href={`/matches/${c.id}`} className="block">
                <MatchCardRow card={c} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <footer className="mt-10 pb-4 text-center text-[10px] leading-5 text-faint">
        本平台输出为量化研究内容，仅供参考，不构成任何投注建议。
        <br />
        概率不等于结果，请理性看待数据。
      </footer>
    </div>
  );
}
