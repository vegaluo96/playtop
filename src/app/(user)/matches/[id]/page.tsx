import Link from "next/link";
import ReportView from "@/components/ReportView";
import UnlockButton from "@/components/UnlockButton";
import VerifyBadge from "@/components/VerifyBadge";
import { LiveBadge, SectionTitle, Tag, STATUS_LABEL, fmtCn } from "@/components/ui";
import { currentUser } from "@/server/auth/guards";
import { getMatchDetail } from "@/server/services/views";

export const dynamic = "force-dynamic";

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const view = getMatchDetail(Number(id), user?.id ?? null, user?.role === "admin");

  if (!view) {
    return (
      <div className="card mt-8 px-4 py-10 text-center text-sm text-muted">
        本场研报尚未发布或不存在。
        <div className="mt-4">
          <Link href="/" className="text-gold-bright underline underline-offset-4">
            返回赛事列表
          </Link>
        </div>
      </div>
    );
  }

  const { card } = view;
  const s = STATUS_LABEL[card.status] ?? { text: card.status, tone: "default" as const };
  const live = card.status === "published";

  return (
    <div className="py-4">
      {/* 比赛头部 */}
      <div className="text-center">
        <div className="text-[10px] tracking-[0.3em] text-faint">
          {card.league}
          {card.round ? ` · ${card.round}` : ""}
          {card.neutral ? " · 中立场" : ""}
        </div>
        <h1 className="font-display mt-2 text-xl tracking-wide">
          {card.homeName}
          <span className="mx-3 text-sm text-faint">VS</span>
          {card.awayName}
        </h1>
        {card.outcome && (
          <div className="tabular font-display mt-2 text-3xl text-gold-bright">
            {card.outcome.homeGoals}
            <span className="mx-2 text-faint">:</span>
            {card.outcome.awayGoals}
          </div>
        )}
        <div className="tabular mt-2 text-[11px] text-muted">开球 {fmtCn(card.kickoffAt)}</div>
        <div className="mt-2 flex items-center justify-center gap-2">
          <Tag tone={s.tone}>{s.text}</Tag>
          {card.version !== null && <Tag>第 {card.version} 版</Tag>}
          <Tag>{card.snapshotTotal} 份数据快照</Tag>
        </div>
      </div>

      {/* 实时改版 / 赛后公开 横幅 */}
      {live && (
        <div className="card mt-4 flex items-center gap-3 border-gold/30 px-3 py-2.5">
          <LiveBadge text="实时研报" />
          <p className="text-[10.5px] leading-4 text-muted">
            本报告随盘口、阵容、天气等数据<b className="text-gold-bright">持续重算改版</b>，截图分享会很快过时；
            开赛瞬间锁定终版并计入战绩。
          </p>
        </div>
      )}
      {card.status === "settled" && view.hoursBeforeKickoffPublished !== null && (
        <div className="card mt-4 border-up/30 px-3 py-2.5 text-[10.5px] leading-5 text-muted">
          ✓ 本报告已赛后免费公开。首版发布于开赛前{" "}
          <b className="tabular text-up">{view.hoursBeforeKickoffPublished.toFixed(1)}</b> 小时，共{" "}
          <b className="tabular text-up">{view.versions.length}</b> 个版本，内容哈希全程可验——我们无法在赛后修改任何赛前结论。
        </div>
      )}

      {view.access === "locked" ? (
        <LockedTeaser view={view} loggedIn={!!user} balance={user?.points ?? null} />
      ) : (
        <>
          <ReportView view={view} />
          {view.analysisId && <VerifyBadge analysisId={view.analysisId} contentHash={view.contentHash} />}
        </>
      )}
    </div>
  );
}

function LockedTeaser({
  view,
  loggedIn,
  balance,
}: {
  view: NonNullable<ReturnType<typeof getMatchDetail>>;
  loggedIn: boolean;
  balance: number | null;
}) {
  const { card } = view;
  return (
    <div className="pb-8">
      <div className="card mt-4 p-4">
        <div className="flex items-center justify-between">
          <span className="font-display text-lg tracking-[0.2em] text-gold-bright">{card.stars ?? "★★★☆"}</span>
          <Tag tone="gold">第 {card.version} 版</Tag>
        </div>
        <div className="relative mt-4 space-y-3 overflow-hidden">
          {/* 模糊骨架：让用户看到报告的结构与体量，但读不到数字 */}
          {[
            "摘要 · 三向概率与研究观点",
            "核心论点",
            "关键驱动因素",
            "模型结果（市场去水 / Dixon-Coles / Elo / 集成）",
            "比分分布 · 衍生市场（大小球 / 亚盘）",
            "价值扫描与 ¼ Kelly 仓位",
            "盘口异动追踪",
            `数据基础（${view.snapshots.total} 份快照 · ${view.snapshots.perKind.length} 个维度）`,
            "风险提示 · 版本演化 · 审计轨迹",
          ].map((t, i) => (
            <div key={i} className="rounded border border-hairline bg-overlay/40 px-3 py-2.5">
              <div className="text-[11px] text-muted">{t}</div>
              <div className="mt-1.5 h-2 rounded bg-faint/20 blur-[2px]" style={{ width: `${88 - i * 6}%` }} />
            </div>
          ))}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-bg to-transparent" />
        </div>
      </div>

      <div className="mt-4">
        <UnlockButton matchId={card.id} price={card.pricePoints ?? 0} loggedIn={loggedIn} balance={balance} />
      </div>

      <SectionTitle>为什么值得解锁</SectionTitle>
      <ul className="space-y-2 text-[12px] leading-6 text-muted">
        <li className="flex gap-2">
          <span className="text-gold">▸</span>
          <span>
            确定性量化引擎（Dixon-Coles / Elo / Shin 去水 / 对数意见池），方法全部来自经同行评审的学术文献，AI 只负责措辞、不产生任何数字。
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-gold">▸</span>
          <span>赛前持续采集 {view.snapshots.perKind.length} 个维度数据并实时改版——你看到的永远是最新一版。</span>
        </li>
        <li className="flex gap-2">
          <span className="text-gold">▸</span>
          <span>所有报告赛后免费公开 + 哈希链存证，战绩页可查全部历史命中与 ROI——我们无法美化过去。</span>
        </li>
      </ul>
    </div>
  );
}
