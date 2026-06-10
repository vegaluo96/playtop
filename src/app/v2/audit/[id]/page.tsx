import Link from "next/link";
import { Tag, fmtCn } from "@/components/ui";
import { v2AuditChain } from "@/server/v2/read";

export const dynamic = "force-dynamic";

/** V2 公开审计页：任意访客可查一场比赛的完整证据链（对象链时间线 + 哈希校验） */
export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chain = v2AuditChain(Number(id));
  if (!chain) {
    return <div className="mx-auto max-w-2xl p-8 text-center text-sm text-muted">比赛不存在。</div>;
  }
  const m = chain.match;
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="card mt-2 px-4 py-3">
      <div className="font-display text-[12px] tracking-wider text-gold-bright">{label}</div>
      <div className="mt-1.5 text-[11.5px] leading-5 text-muted">{children}</div>
    </div>
  );
  const hash8 = (h: string | null) => (h ? `${h.slice(0, 8)}…` : "—");
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="text-center">
        <div className="text-[10px] tracking-wider text-faint">公开审计 · 无需登录 · 链上可验</div>
        <h1 className="font-display mt-1 text-lg tracking-wide">
          {m.home} vs {m.away}
        </h1>
        <div className="tabular mt-1 text-[11px] text-muted">
          {m.league} · 开球 {fmtCn(m.kickoffAt)} · 状态 {m.status}
          {m.homeScore !== null ? ` · 赛果 ${m.homeScore}:${m.awayScore}` : ""}
        </div>
      </div>

      <Row label={`① 研究快照（${chain.snapshots.length} 份，链式哈希）`}>
        {chain.snapshots.length === 0 && "尚无快照。"}
        {chain.snapshots.map((s) => (
          <div key={s.id} className="tabular flex justify-between border-t border-hairline py-1 first:border-t-0">
            <span>
              <Tag tone="info">{s.snapshotType}</Tag> <span className="ml-1">{fmtCn(s.capturedAt)}</span>
            </span>
            <span className="text-faint">
              {hash8(s.previousSnapshotHash)} → {hash8(s.snapshotHash)}
            </span>
          </div>
        ))}
      </Row>

      <Row label={`② 盘口快照（扁平化 ${chain.oddsSnapshotCount} 行） + 模型运行（${chain.modelRuns.length} 次）`}>
        {chain.modelRuns.map((r) => (
          <div key={r.id} className="tabular flex justify-between border-t border-hairline py-1 first:border-t-0">
            <span>
              #{r.id} {r.modelVersion} <Tag tone={r.status === "success" ? "up" : "down"}>{r.status}</Tag>
            </span>
            <span className="text-faint">输入 {hash8(r.inputHash)} · 输出 {hash8(r.outputHash)}</span>
          </div>
        ))}
        {chain.modelRuns.length === 0 && "尚未运行模型。"}
      </Row>

      <Row label={`③ 研报版本（${chain.reportVersions.length} 版，链式哈希）`}>
        {chain.reportVersions.map((v) => (
          <div key={v.id} className="tabular flex justify-between border-t border-hairline py-1 first:border-t-0">
            <span>
              <Tag>{v.versionType}</Tag> <span className="ml-1">{fmtCn(v.createdAt)}</span>
              {v.isPublic === 1 && <Tag tone="up">已公开</Tag>}
            </span>
            <span className="text-faint">
              {hash8(v.previousReportHash)} → {hash8(v.reportHash)}
            </span>
          </div>
        ))}
        {chain.reportVersions.length === 0 && "尚无版本。"}
      </Row>

      <Row label="④ 开赛锁定">
        {chain.lock ? (
          <span className="tabular">
            锁定于 {fmtCn(chain.lock.lockedAt)} · 终版三元组（快照 #{chain.lock.finalSnapshotId} / 运行 #
            {chain.lock.finalModelRunId} / 版本 #{chain.lock.finalReportVersionId}）· 锁定哈希 {hash8(chain.lock.lockHash)}
          </span>
        ) : (
          "尚未锁定（开赛时自动锁定）。"
        )}
      </Row>

      <Row label={`⑤ 赛后结算（${chain.settlements.length} 个观点）`}>
        {chain.settlements.map((s) => (
          <div key={s.id} className="tabular flex justify-between border-t border-hairline py-1 first:border-t-0">
            <span>
              <Tag tone={s.result === "win" || s.result === "half_win" ? "up" : s.result === "lose" || s.result === "half_lose" ? "down" : "default"}>
                {s.result}
              </Tag>
              <span className="ml-1">
                ROI {s.roi !== null ? `${s.roi >= 0 ? "+" : ""}${(s.roi * 100).toFixed(1)}%` : "—"} · CLV{" "}
                {s.clv !== null ? `${s.clv >= 0 ? "+" : ""}${(s.clv * 100).toFixed(1)}%` : "—"} · Brier{" "}
                {s.brierScore?.toFixed(4) ?? "—"}
              </span>
            </span>
            <span className="text-faint">{hash8(s.settlementHash)}</span>
          </div>
        ))}
        {chain.settlements.length === 0 && "尚未结算。"}
      </Row>

      <Row label="⑥ 全局审计链校验">
        {Object.entries(chain.chains).map(([k, v]) => (
          <div key={k} className="flex justify-between border-t border-hairline py-1 first:border-t-0">
            <span>{k}</span>
            <span className={v.ok ? "text-up" : "text-down"}>
              {v.ok ? `✓ 完整（${v.length} 节）` : `✗ 断链于 #${v.brokenAt}`}
            </span>
          </div>
        ))}
      </Row>

      <div className="mt-6 text-center">
        <Link href={`/matches/${m.id}`} className="text-gold-bright underline underline-offset-4">
          查看研报 →
        </Link>
      </div>
      <p className="mt-4 pb-6 text-center text-[10px] leading-4 text-faint">
        本页所有哈希在写入时即链式固化：删除或篡改任何历史对象都会使链校验失败。
      </p>
    </div>
  );
}
