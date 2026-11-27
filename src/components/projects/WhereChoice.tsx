import { Cloud, Laptop } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ThreadWhere } from "@/lib/projects/types";

/** Where a project's threads run by default: this computer, or the Nyxs cloud when the project
 *  and its model can (`cloudBlocked` says why not). */
export function WhereChoice({ value, onChange, cloudBlocked }: { value: ThreadWhere; onChange: (v: ThreadWhere) => void; cloudBlocked?: string }) {
  const t = useTranslations().projects;
  const option = (where: ThreadWhere, Icon: typeof Laptop, label: string, disabled = false) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === where}
      disabled={disabled}
      onClick={() => onChange(where)}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] transition-colors",
        value === where ? "bg-bg-100 text-text-100 shadow-sm" : "text-text-300 enabled:hover:text-text-100",
        disabled && "cursor-not-allowed text-text-500",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label={t.whereLabel} className="inline-flex items-center gap-0.5 rounded-[6px] bg-bg-200 p-0.5">
      {option("local", Laptop, t.thisComputer)}
      {option("cloud", Cloud, t.cloud, !!cloudBlocked)}
    </div>
  );
}
