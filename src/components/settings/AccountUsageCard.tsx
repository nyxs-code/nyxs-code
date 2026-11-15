import type { ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { PlanLimit } from "@/lib/claudeCode";
import { useTranslations } from "@/lib/i18n";
import { planLimitLabel } from "@/lib/planLimits";

/** A signed-in account the way zeron lists one: its initial, who it is, its plan, and how much
 *  of each plan limit is used. `limits` null means they can't be read for this account. */
export function AccountUsageCard({
  title,
  subtitle,
  initialOf,
  limits,
  loadingLimits = false,
  refreshing = false,
  refreshLabel,
  onRefresh,
  children,
}: {
  title: string;
  subtitle?: string;
  /** What the avatar's letter comes from, when the title isn't a name ("Signed in to…"). */
  initialOf?: string;
  limits: PlanLimit[] | null;
  loadingLimits?: boolean;
  refreshing?: boolean;
  refreshLabel: string;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations().chatInput;
  const initial = (initialOf ?? title).trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="mb-3 rounded-[8px] border border-bg-300 bg-bg-200/40 px-3 py-2.5 space-y-2.5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="w-8 h-8 shrink-0 rounded-full border border-accent/60 flex items-center justify-center text-[13px] font-medium text-text-200"
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-text-100 truncate">{title}</p>
          {subtitle && <p className="text-[12px] text-text-400 truncate">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="p-1 rounded-[6px] text-text-400 hover:text-text-100 shrink-0 disabled:opacity-50"
          aria-label={refreshLabel}
          data-tooltip={refreshLabel}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
      {limits && limits.length > 0 ? (
        <div className="pl-11 space-y-1.5">
          {limits.map((limit, i) => (
            <UsageBar key={`${limit.kind}-${limit.model ?? ""}-${i}`} label={planLimitLabel(limit, t)} used={limit.utilization} />
          ))}
        </div>
      ) : (
        loadingLimits && (
          <p className="pl-11 text-[12px] text-text-400 inline-flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> {t.usageLoading}
          </p>
        )
      )}
      {children}
    </div>
  );
}

function UsageBar({ label, used }: { label: string; used: number }) {
  const color = used >= 100 ? "bg-red-500" : used >= 80 ? "bg-amber-500" : "bg-accent";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_2.5rem] items-center gap-2.5">
      <span className="text-[12px] leading-4 text-text-300 break-words">{label}</span>
      <div className="h-1 rounded-sm bg-bg-300 overflow-hidden">
        <div className={`h-full rounded-sm ${color}`} style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />
      </div>
      <span className="text-[12px] tabular-nums text-text-400 text-right">{used}%</span>
    </div>
  );
}
