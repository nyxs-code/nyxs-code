import { modelDisplayName } from "@/lib/models";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A model with its on/off switch: the name alone, the whole row toggles it. Manage models and
 *  Settings › Providers (API providers and agents) list models with it. */
export function ModelSwitchRow({
  name,
  checked,
  onToggle,
  className,
}: {
  /** The model's name as listed; shown without the provider's decorations (modelDisplayName). */
  name: string;
  checked: boolean;
  onToggle: () => void;
  /** Extra classes for the row, e.g. a tighter corner in a compact list. */
  className?: string;
}) {
  const t = useTranslations().models;
  const label = modelDisplayName(name);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? `${t.disable} ${label}` : `${t.enable} ${label}`}
      onClick={onToggle}
      className={cn("w-full flex items-center gap-3 px-2 py-1 rounded-[6px] text-left transition-colors hover:bg-bg-200", className)}
    >
      <span className="flex-1 min-w-0 text-[13px] leading-5 font-medium text-text-100 truncate">{label}</span>
      <span className={`w-8 h-[18px] shrink-0 rounded-full transition-colors relative ${checked ? "bg-accent" : "bg-bg-300"}`}>
        <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-bg-0 transition-all ${checked ? "left-4" : "left-[2px]"}`} />
      </span>
    </button>
  );
}
