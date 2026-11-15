import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Orb } from "@/components/ui/thinking-orbs";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { TOOL_VERBS } from "./toolFormat";
import { elapsedLabel, liveElapsedLabel, orbLookFor, tokensLabel, type LiveTurn } from "./liveFormat";

function usePhaseLabel(live: LiveTurn): string {
  const tr = useTranslations();
  const tMsg = tr.message;
  switch (live.phase) {
    case "thinking":
      return tMsg.reasoningActive;
    case "tool": {
      const verb = live.tool ? (tr.toolVerbs[live.tool] ?? TOOL_VERBS[live.tool])?.[0] : undefined;
      return verb ? `${verb}…` : tMsg.usingTool;
    }
    case "writing":
      return tMsg.writing;
    case "confirm":
      return tMsg.waitingPermission;
    case "ask":
      return tMsg.waitingAnswer;
    case "compacting":
      return tMsg.compactingLive;
    case "retrying":
      return live.rateLimited ? tMsg.rateLimitedLive : tMsg.retryingLive;
    default:
      return live.wake ? tMsg.backgroundLive : tMsg.working;
  }
}

/** The turn's clock ticks every 100ms on its own, so only this span re-renders that often and
 *  not the orb and label animations around it. */
function LiveClock({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return <>{liveElapsedLabel(now - startedAt)}</>;
}

export function LiveStatus({ live }: { live: LiveTurn }) {
  const tr = useTranslations();
  const tUi = tr.chatUi;
  const tMsg = tr.message;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const waiting = live.phase === "confirm" || live.phase === "ask";
  const label = usePhaseLabel(live);
  const orb = orbLookFor(live);
  const orbKey = `${orb.state ?? "base"}-${orb.variant ?? "default"}`;
  const travel = useReducedMotion() ? 0 : 8;
  const elapsedMs = now - live.startedAt;
  const tokens = typeof live.tokens === "number" && live.tokens > 0 ? tokensLabel(live.tokens) : "";
  const secs = elapsedMs / 1000;
  const tps = live.tokens && secs >= 1 ? live.tokens / secs : 0;
  const tip = [tps > 0 ? `${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s` : "", waiting ? "" : tUi.escToStop]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-3 flex items-center gap-2 text-[12px] text-text-400" data-tooltip={tip || undefined}>
      <span className="relative inline-flex shrink-0 w-5 h-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={orbKey}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn("inline-flex", waiting ? "text-text-400" : "text-text-300")}
          >
            <Orb {...orb} size={20} dotSize={1.6} />
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="tabular-nums">
        <LiveClock startedAt={live.startedAt} />
        {tokens && ` · ${tokens}`}
      </span>
      <span aria-hidden>·</span>
      <span className="relative inline-flex overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={label}
            initial={{ opacity: 0, y: travel }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -travel }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="inline-flex"
          >
            {waiting ? (
              <span className="font-medium text-text-300">{label}</span>
            ) : (
              <TextShimmer className="text-[12px] font-medium">{label}</TextShimmer>
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      {/* Apart from the label, so the countdown doesn't replay its animation every second. */}
      {live.phase === "retrying" && live.retryAt && live.retryAt > now && (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{tMsg.retryIn.replace("{time}", elapsedLabel(live.retryAt - now))}</span>
        </>
      )}
    </div>
  );
}
