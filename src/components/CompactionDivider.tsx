import { useEffect, useState, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { Orb } from "@/components/ui/thinking-orbs";
import { elapsedLabel } from "@/components/message/liveFormat";
import type { CompactionMark } from "@/lib/chatStore";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** "312k", "20.5k", "940". */
function shortTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
}

function Rule({ sweep, reverse }: { sweep?: boolean; reverse?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("relative flex-1 h-px overflow-hidden bg-bg-300", sweep && "compact-sweep", sweep && reverse && "compact-sweep-reverse")}
    />
  );
}

function Row({ sweep, children }: { sweep?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 animate-fade-in">
      <Rule sweep={sweep} reverse />
      <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12px] text-text-300">{children}</span>
      <Rule sweep={sweep} />
    </div>
  );
}

/** Where `/compact` is running: the divider the finished one leaves, still being drawn. */
export function CompactingDivider() {
  const t = useTranslations().app;
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div role="status" className="my-5">
      <Row sweep>
        <span className="inline-flex text-accent">
          <Orb state="compacting" size={16} dotSize={1.4} />
        </span>
        <span className="font-medium text-text-200">{t.compactingConversation}</span>
        <span className="tabular-nums text-text-400">{elapsedLabel(now - startedAt)}</span>
      </Row>
    </div>
  );
}

/** A finished compaction (`/compact` or an automatic one): from here on the model sees a summary
 *  of what came before. */
export function CompactionDivider({ mark }: { mark: CompactionMark }) {
  const t = useTranslations().app;
  const { beforeTokens: before, afterTokens: after } = mark;
  const sized = !!before && !!after;
  const kept = sized ? Math.min(100, (after / before) * 100) : 100;
  // The bar starts full and empties to what is left, once, when the divider appears.
  const [width, setWidth] = useState(100);
  useEffect(() => {
    const id = requestAnimationFrame(() => setWidth(kept));
    return () => cancelAnimationFrame(id);
  }, [kept]);

  return (
    <div className="my-5">
      <Row>
        <CircleCheck className="w-3.5 h-3.5 text-accent" aria-hidden />
        <span className="font-medium text-text-200">{t.conversationCompacted}</span>
        <span className="tabular-nums text-text-400">· {elapsedLabel(mark.ms)}</span>
      </Row>
      {sized && (
        <div className="mt-2 mx-auto max-w-[460px] rounded-[8px] border border-bg-300 bg-bg-100 px-3 py-2.5 animate-fade-in">
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[12px] text-text-300">
            <span>{t.compactionContext}</span>
            <span className="tabular-nums">
              {t.compactionFreed
                .replace("{before}", shortTokens(before))
                .replace("{after}", shortTokens(after))
                .replace("{pct}", String(Math.max(0, Math.round(100 - kept))))}
            </span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-accent/20">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${width}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
