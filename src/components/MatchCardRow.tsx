import { Tag, STATUS_LABEL, fmtCn } from "@/components/ui";
import type { MatchCard } from "@/server/services/views";

export default function MatchCardRow({ card }: { card: MatchCard }) {
  const s = STATUS_LABEL[card.status] ?? { text: card.status, tone: "default" as const };
  const free = card.status === "settled";
  return (
    <div className="card px-3.5 py-3 transition-colors hover:border-gold/40">
      <div className="flex items-center justify-between text-[10px] text-faint">
        <span className="tracking-wider">
          {card.league}
          {card.round ? ` · ${card.round}` : ""}
          {card.neutral ? " · 中立场" : ""}
        </span>
        <span className="tabular">{fmtCn(card.kickoffAt)}</span>
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-wide">
            {card.homeName}
            <span className="mx-2 text-faint">vs</span>
            {card.awayName}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Tag tone={s.tone}>{s.text}</Tag>
            {card.stars && <Tag tone="gold">{card.stars}</Tag>}
          </div>
        </div>
        <div className="ml-3 shrink-0 text-right">
          {card.outcome ? (
            <div className="tabular font-display text-xl text-gold-bright">
              {card.outcome.homeGoals}
              <span className="mx-1 text-faint">:</span>
              {card.outcome.awayGoals}
            </div>
          ) : free ? (
            <Tag tone="up">免费</Tag>
          ) : card.unlocked ? (
            <Tag tone="up">已解锁</Tag>
          ) : (
            <div className="rounded border border-gold/50 bg-gold/10 px-2 py-1 text-center">
              <div className="tabular text-sm font-bold text-gold-bright">{card.pricePoints}</div>
              <div className="text-[9px] tracking-wider text-gold/80">积分解锁</div>
            </div>
          )}
        </div>
      </div>
      {card.verdict && <div className="mt-2 border-t border-hairline pt-2 text-[11px] text-muted">{card.verdict}</div>}
    </div>
  );
}
