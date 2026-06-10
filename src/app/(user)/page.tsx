import Link from "next/link";
import { count } from "drizzle-orm";
import { db } from "@/server/db";
import { dataSnapshots, historyMatches } from "@/server/db/schema";
import { currentUser } from "@/server/auth/guards";
import { listMatchCards, type MatchCard } from "@/server/services/views";
import { Stat, fmtDateCn } from "@/components/ui";
import MatchCardRow from "@/components/MatchCardRow";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await currentUser();
  const cards = listMatchCards(user?.id ?? null);
  const snapshotCount = db.select({ n: count() }).from(dataSnapshots).get()?.n ?? 0;
  const historyCount = db.select({ n: count() }).from(historyMatches).get()?.n ?? 0;

  const groups = new Map<string, MatchCard[]>();
  for (const c of cards) {
    const key = fmtDateCn(c.kickoffAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  return (
    <div className="py-4">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="历史样本库" value={historyCount.toLocaleString()} sub="场赛果驱动模型" />
        <Stat label="累计数据快照" value={snapshotCount.toLocaleString()} sub="实时采集中" accent />
        <Stat label="覆盖赛事" value={cards.length} sub="赛后全部免费公开" />
      </div>

      <p className="mt-4 rounded-lg border border-gold/20 bg-gold/5 px-3 py-2 text-[11px] leading-5 text-muted">
        每份研报的数字都由<b className="text-gold-bright">量化模型</b>计算（AI 不参与任何计算）；
        赛前随数据变化<b className="text-gold-bright">自动改版</b>，开赛锁定存证、赛后免费公开——
        我们无法事后修改任何预测，<b className="text-gold-bright">战绩页</b>可验证全部历史。
      </p>

      {groups.size === 0 && (
        <div className="card mt-6 px-4 py-10 text-center text-sm text-muted">
          暂无已发布赛事研报，请稍后再来。
        </div>
      )}

      {[...groups.entries()].map(([date, list]) => (
        <section key={date} className="mt-5">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="font-display text-[13px] tracking-[0.2em] text-muted">{date}</h2>
            <div className="gold-rule flex-1" />
          </div>
          <div className="space-y-2.5">
            {list.map((c) => (
              <Link key={c.id} href={`/matches/${c.id}`} className="block">
                <MatchCardRow card={c} />
              </Link>
            ))}
          </div>
        </section>
      ))}

      <footer className="mt-10 pb-4 text-center text-[10px] leading-5 text-faint">
        本平台输出为量化研究内容，仅供参考，不构成任何投注建议。
        <br />
        概率不等于结果，请理性看待数据。
      </footer>
    </div>
  );
}
