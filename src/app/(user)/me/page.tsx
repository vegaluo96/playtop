import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { matches, pointTransactions, teams, unlocks } from "@/server/db/schema";
import { alias } from "drizzle-orm/sqlite-core";
import { currentUser } from "@/server/auth/guards";
import { SectionTitle, Tag, fmtCn } from "@/components/ui";
import LogoutButton from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

const TX_LABEL: Record<string, string> = {
  admin_grant: "管理员充值",
  admin_deduct: "管理员扣减",
  unlock: "解锁研报",
  refund: "退款",
};

export default async function MePage() {
  const user = await currentUser();
  if (!user) {
    return (
      <div className="card mx-auto mt-8 max-w-md px-4 py-10 text-center">
        <p className="text-sm text-muted">登录后查看积分与解锁记录</p>
        <div className="mt-4 flex justify-center gap-3">
          <Link href="/login" className="rounded border border-gold/50 px-4 py-2 text-sm text-gold-bright">
            登录
          </Link>
          <Link href="/register" className="rounded border border-hairline px-4 py-2 text-sm text-muted">
            注册
          </Link>
        </div>
      </div>
    );
  }

  const txs = db
    .select()
    .from(pointTransactions)
    .where(eq(pointTransactions.userId, user.id))
    .orderBy(desc(pointTransactions.createdAt))
    .limit(50)
    .all();
  const home = alias(teams, "home_team");
  const away = alias(teams, "away_team");
  const unlockRows = db
    .select({ u: unlocks, m: matches, homeName: home.name, awayName: away.name })
    .from(unlocks)
    .innerJoin(matches, eq(matches.id, unlocks.matchId))
    .innerJoin(home, eq(home.id, matches.homeTeamId))
    .innerJoin(away, eq(away.id, matches.awayTeamId))
    .where(eq(unlocks.userId, user.id))
    .orderBy(desc(unlocks.createdAt))
    .limit(50)
    .all();

  return (
    <div className="mx-auto max-w-2xl py-4">
      <div className="card p-5 text-center">
        <div className="text-[10px] tracking-wider text-faint">积分余额</div>
        <div className="tabular font-display mt-1 text-4xl text-gold-bright">{user.points}</div>
        <div className="mt-2 text-[11px] text-muted">
          {user.username}
          {user.role === "admin" && (
            <Link href="/admin" className="ml-2 text-gold-bright underline underline-offset-4">
              进入管理后台 →
            </Link>
          )}
        </div>
        <p className="mt-3 border-t border-hairline pt-3 text-[10px] leading-5 text-faint">
          平台不提供自助充值，积分由管理员人工添加——请线下联系管理员。
        </p>
      </div>

      <SectionTitle>已解锁研报</SectionTitle>
      {unlockRows.length === 0 ? (
        <p className="text-[12px] text-faint">尚未解锁任何研报。</p>
      ) : (
        <div className="space-y-2">
          {unlockRows.map((r) => (
            <Link key={r.u.id} href={`/matches/${r.m.id}`} className="card flex items-center justify-between px-3.5 py-2.5">
              <div>
                <div className="text-[13px]">
                  {r.homeName} <span className="text-faint">vs</span> {r.awayName}
                </div>
                <div className="tabular mt-0.5 text-[10px] text-faint">{fmtCn(r.u.createdAt)}</div>
              </div>
              <Tag tone="gold">-{r.u.pointsSpent} 分</Tag>
            </Link>
          ))}
        </div>
      )}

      <SectionTitle>积分流水</SectionTitle>
      {txs.length === 0 ? (
        <p className="text-[12px] text-faint">暂无流水。</p>
      ) : (
        <table className="tabular w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] tracking-wider text-faint">
              <th className="pb-1 font-normal">时间</th>
              <th className="pb-1 font-normal">类型</th>
              <th className="pb-1 text-right font-normal">变动</th>
              <th className="pb-1 text-right font-normal">余额</th>
            </tr>
          </thead>
          <tbody>
            {txs.map((t) => (
              <tr key={t.id} className="border-t border-hairline">
                <td className="py-1.5 text-muted">{fmtCn(t.createdAt)}</td>
                <td className="py-1.5">{TX_LABEL[t.type] ?? t.type}</td>
                <td className={`py-1.5 text-right ${t.delta >= 0 ? "text-up" : "text-down"}`}>
                  {t.delta >= 0 ? "+" : ""}
                  {t.delta}
                </td>
                <td className="py-1.5 text-right text-muted">{t.balanceAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-8">
        <LogoutButton />
      </div>
    </div>
  );
}
