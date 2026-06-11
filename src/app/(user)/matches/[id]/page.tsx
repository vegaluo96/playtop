import Link from "next/link";
import ReportView from "@/components/ReportView";
import UnlockButton from "@/components/UnlockButton";
import VerifyBadge from "@/components/VerifyBadge";
import { LiveBadge, SectionTitle, Tag, STATUS_LABEL, fmtCn } from "@/components/ui";
import { currentUser } from "@/server/auth/guards";
import { getMatchDetail, getUpcomingFixture } from "@/server/services/views";

export const dynamic = "force-dynamic";

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const view = getMatchDetail(Number(id), user?.id ?? null, user?.role === "admin");

  if (!view) {
    // 赛程已建、研报未发布（世界杯等自动导入的未来场次）：展示赛程与自动发布说明
    const up = getUpcomingFixture(Number(id));
    if (up) {
      const hours = Math.max(1, Math.round((up.kickoffAt - Date.now()) / 3_600_000));
      return (
        <div className="mx-auto max-w-3xl py-4">
          <div className="text-center">
            <div className="text-[10px] tracking-wider text-faint">
              {up.league}
              {up.round ? ` · ${up.round}` : ""}
              {up.neutral ? " · 中立场" : ""}
            </div>
            <h1 className="font-display mt-2 text-xl tracking-wide">
              {up.homeName}
              <span className="mx-3 text-sm text-faint">VS</span>
              {up.awayName}
            </h1>
            <div className="tabular mt-2 text-[11px] text-muted">开球 {fmtCn(up.kickoffAt)}</div>
            <div className="mt-2 flex items-center justify-center gap-2">
              <Tag tone="info">研报准备中</Tag>
              {up.snapshotTotal > 0 && <Tag>{up.snapshotTotal} 份数据已采集</Tag>}
            </div>
          </div>
          <div className="card mt-5 px-4 py-5 text-center text-[12px] leading-6 text-muted">
            本场研报由系统全自动生成：临近开赛将自动采集多家盘口与情报数据、
            运行量化引擎并发布（距开球约 <b className="tabular text-gold-bright">{hours}</b> 小时）。
            发布后赛前持续自动改版，开赛锁定存证，赛后免费公开。
          </div>
          <div className="mt-5 text-center">
            <Link href="/" className="text-gold-bright underline underline-offset-4">
              返回赛事列表
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="card mx-auto mt-8 max-w-3xl px-4 py-10 text-center text-sm text-muted">
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
    <div className="mx-auto max-w-3xl py-4">
      {/* 比赛头部 */}
      <div className="text-center">
        <div className="text-[10px] tracking-wider text-faint">
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
          {card.freeBeta && card.status === "published" && <Tag tone="up">公测免费</Tag>}
          {card.version !== null && <Tag>第 {card.version} 版</Tag>}
          <Tag>{card.snapshotTotal} 份数据快照</Tag>
        </div>
      </div>

      {/* 实时改版横幅（含刷新节奏阶梯） */}
      {live && <RefreshLadder kickoffAt={card.kickoffAt} />}
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

/**
 * 盘口刷新节奏指示条（用户可见的服务承诺）：
 * >12h 静默 → 12h~30min 每 30 分钟 → 30~10min 每 5 分钟 → 最后 10 分钟每分钟。
 * 当前档位高亮，越临近开赛越"热"——配合 60s 页面自动刷新，临场分钟级更新肉眼可见。
 */
function RefreshLadder({ kickoffAt }: { kickoffAt: number }) {
  const mins = (kickoffAt - Date.now()) / 60_000;
  if (mins <= 0) return null;
  const stages = [
    { label: "盘口静默", range: "开赛前 12 小时以上", active: mins > 720 },
    { label: "每 30 分钟", range: "12 小时 ~ 30 分钟", active: mins <= 720 && mins > 30 },
    { label: "每 5 分钟", range: "30 ~ 10 分钟", active: mins <= 30 && mins > 10 },
    { label: "每分钟", range: "最后 10 分钟", active: mins <= 10 },
  ];
  const current = stages.find((s) => s.active)!;
  return (
    <div className="card mt-4 border-gold/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LiveBadge text="实时研报" />
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-gold-bright">
          {current.label !== "盘口静默" && <span className="pulse-dot" />}
          盘口刷新：{current.label}
          <span className="font-normal text-faint">（{current.range}）</span>
        </span>
      </div>
      <div className="mt-2 flex gap-1">
        {stages.map((s) => (
          <div key={s.label} className="flex-1">
            <div className={`h-1 rounded-full ${s.active ? "bg-gold" : "bg-overlay"}`} />
            <div className={`mt-1 text-center text-[9px] ${s.active ? "font-semibold text-gold-bright" : "text-faint"}`}>{s.label}</div>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] leading-4 text-faint">
        报告随盘口/阵容/天气持续重算改版，越临近开赛刷新越快；开赛瞬间锁定终版并计入战绩。
      </p>
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
          <span className="font-display text-lg tracking-wide text-gold-bright">{card.stars ?? "评级待解锁"}</span>
          <Tag tone="gold">第 {card.version} 版</Tag>
        </div>
        <div className="relative mt-4 space-y-3 overflow-hidden">
          {/* 模糊骨架：让用户看到报告的结构与体量，但读不到数字 */}
          {[
            "赛前观点 · 方向与评级",
            "最低可接受赔率（价格边界线）",
            "核心论点 · 三向概率",
            "关键驱动因素",
            "模型结果（市场去水 / Dixon-Coles / Elo / 集成）",
            "比分分布 · 衍生市场（大小球 / 亚盘）",
            "价值扫描与模拟单位（风险刻度）",
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
            方向 + 价格边界：每条观点都给出<b className="text-ink">最低可接受赔率</b>——拿你看到的实际价格一对照，低于边界即失去参考价值，判断只需十秒。
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-gold">▸</span>
          <span>
            确定性量化引擎（Dixon-Coles / Elo / Shin 去水 / 对数意见池），方法全部来自经同行评审的学术文献，AI 只负责措辞、不产生任何数字；赛前持续采集 {view.snapshots.perKind.length} 个维度数据并实时改版。
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-gold">▸</span>
          <span>所有报告赛后免费公开 + 哈希链存证，战绩页可查全部历史命中、ROI 与收盘价值——我们无法美化过去，观望也计入档案。</span>
        </li>
      </ul>
    </div>
  );
}
