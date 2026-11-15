import { useState } from "react";
import { ChevronUp, GitMerge, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import type { MergedPrCard } from "@/lib/mergedPrCards";

/** GitHub's "Merged" purple, the colour people already read as merged. */
const MERGED_BG = "bg-[#8250df]";

function Card({ card, onDismiss, dismissLabel, extra, className }: {
  card: MergedPrCard;
  onDismiss: () => void;
  dismissLabel: string;
  /** "+3" on the front card of a collapsed stack. */
  extra?: string;
  className?: string;
}) {
  const t = useTranslations().gitBar;
  return (
    <div className={cn("relative flex items-center gap-2 rounded-[8px] py-2 pl-3 pr-2 text-[13px] text-white", MERGED_BG, className)}>
      <GitMerge className="h-[18px] w-[18px] shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">
        {t.prMergedInto.replace("{n}", String(card.number)).replace("{base}", card.base || "main")}
      </span>
      {extra && <span className="shrink-0 rounded-[6px] bg-white/20 px-1.5 text-[12px] tabular-nums">{extra}</span>}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        aria-label={dismissLabel}
        data-tooltip={dismissLabel}
        className="shrink-0 rounded-[6px] p-0.5 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The purple cards for PRs merged in this chat. Several stack up collapsed, like a deck of
 *  notifications: the newest in front with "+N", the edges of the rest showing under it; a
 *  click spreads them out. */
export function MergedPrCards({ cards, onDismiss }: { cards: MergedPrCard[]; onDismiss: (urls: string[]) => void }) {
  const t = useTranslations().gitBar;
  const [expanded, setExpanded] = useState(false);
  if (!cards.length) return null;

  if (cards.length === 1) {
    return (
      <div className="mx-2 mb-1.5 md:mx-0">
        <Card card={cards[0]} onDismiss={() => onDismiss([cards[0].url])} dismissLabel={t.dismissMergedPr} />
      </div>
    );
  }

  if (expanded) {
    return (
      <div className="mx-2 mb-1.5 flex flex-col gap-1 md:mx-0">
        {cards.map((c) => (
          <Card key={c.url} card={c} onDismiss={() => onDismiss([c.url])} dismissLabel={t.dismissMergedPr} />
        ))}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[12px] text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
          >
            {t.collapseMergedPrs}
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={false}
      aria-label={t.showMergedPrs.replace("{n}", String(cards.length))}
      onClick={() => setExpanded(true)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(true); } }}
      className="relative mx-2 mb-1.5 cursor-pointer pb-2.5 md:mx-0"
    >
      {/* The edges of the cards behind: two at most, however many there are. */}
      <div aria-hidden className={cn("absolute inset-x-4 bottom-0 h-3 rounded-b-[8px] opacity-35", MERGED_BG)} />
      <div aria-hidden className={cn("absolute inset-x-2 bottom-[5px] h-3 rounded-b-[8px] opacity-60", MERGED_BG)} />
      <Card
        card={cards[0]}
        extra={`+${cards.length - 1}`}
        onDismiss={() => onDismiss(cards.map((c) => c.url))}
        dismissLabel={t.dismissAllMergedPrs}
      />
    </div>
  );
}
