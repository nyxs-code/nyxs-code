import { useEffect, useState, useSyncExternalStore } from "react";
import { CirclePause, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { accountKey } from "@/lib/accountScope";
import { subscribeSettings } from "@/lib/settingsRuntime";
import { planLimitWarning as planLimitWarningOn } from "@/lib/featureSettings";
import {
  cachedClaudePlanUsage,
  claudePlanRefusal,
  onClaudePlanRefusal,
  onClaudePlanUsage,
  type PlanUsage,
} from "@/lib/claudeCode";
import { planLimitLabel, planWarning, resetLabel } from "@/lib/planLimits";
import { OPEN_CONTEXT_METER_EVENT } from "@/components/ui/chat-input/ContextMeter";

const DISMISSED_KEY = "nyxs.planWarningDismissed.v1";
/** Old dismissals stop mattering once their window resets; only the latest few are kept. */
const DISMISSED_MAX = 20;

function storedDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(DISMISSED_KEY)) || "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A strip over the composer when a Claude Code plan limit nears its cap (75 %, then 90 %) or the
 * plan turns requests away. Sits above the Git bar when both show. The warning can be dismissed
 * per step and window; the refusal stays until it resets.
 */
export function PlanLimitBar() {
  const t = useTranslations().chatInput;
  const enabled = useSyncExternalStore(subscribeSettings, planLimitWarningOn);
  const [usage, setUsage] = useState<PlanUsage | null>(() => cachedClaudePlanUsage());
  const [refusal, setRefusal] = useState(() => claudePlanRefusal());
  const [dismissed, setDismissed] = useState(storedDismissed);
  // The countdown and the end of a refusal move with the clock, not with any event.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onClaudePlanUsage(setUsage), []);
  useEffect(() => onClaudePlanRefusal(() => setRefusal(claudePlanRefusal())), []);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      setRefusal(claudePlanRefusal());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!enabled) return null;
  const warning = planWarning(usage, refusal, new Set(dismissed), now);
  if (!warning) return null;

  const refused = warning.level === "refused";
  const label = warning.limit ? planLimitLabel(warning.limit, t) : t.planLimitGeneric;
  const resetAt = refused ? warning.until : warning.limit.resetsAt;
  const kind = warning.limit?.kind ?? null;
  const reset = resetAt ? resetLabel(kind, resetAt, t, now) : "";
  const text = refused
    ? t.planLimitReached.replace("{label}", label)
    : t.planLimitUsed.replace("{label}", label).replace("{pct}", String(warning.limit.utilization));

  const dismiss = () => {
    if (warning.level !== "warn") return;
    const next = [...dismissed.filter((k) => k !== warning.key), warning.key].slice(-DISMISSED_MAX);
    setDismissed(next);
    try { localStorage.setItem(accountKey(DISMISSED_KEY), JSON.stringify(next)); } catch { /* storage full: shows again next start */ }
  };

  return (
    <div
      role={refused ? "alert" : "status"}
      className={cn(
        "relative z-0 mx-2 md:mx-0 mb-2 flex items-center gap-2 rounded-[8px] py-1.5 pl-3.5 pr-1.5 text-[13px]",
        refused ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-amber-500/10 text-amber-800 dark:text-amber-300",
      )}
    >
      {refused ? <CirclePause className="h-4 w-4 shrink-0" /> : <TriangleAlert className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">
        {text}
        {reset && <span className="opacity-75"> · {reset}</span>}
      </span>
      {!refused && (
        <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-amber-500/20" aria-hidden>
          <span className="block h-full rounded-full bg-amber-500" style={{ width: `${warning.limit.utilization}%` }} />
        </span>
      )}
      <button
        type="button"
        // Keeps the context meter's outside-click handler from closing it on the way in.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => window.dispatchEvent(new Event(OPEN_CONTEXT_METER_EVENT))}
        className="shrink-0 rounded-[6px] px-2 py-0.5 text-[12.5px] underline underline-offset-2 hover:bg-black/5 dark:hover:bg-white/10"
      >
        {t.planViewUsage}
      </button>
      {!refused && (
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.planDismiss}
          className="shrink-0 rounded-[6px] p-1 opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
