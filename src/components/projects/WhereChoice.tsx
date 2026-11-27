import { Cloud, Laptop } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Where a project's threads run: this computer, or the Nyxs cloud, which shows but can't be
 *  picked until it ships ("Pronto"). */
export function WhereChoice() {
  const t = useTranslations().projects;
  return (
    <div role="radiogroup" aria-label={t.whereLabel} className="inline-flex items-center gap-0.5 rounded-[6px] bg-bg-200 p-0.5">
      <button type="button" role="radio" aria-checked className={cn("inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] bg-bg-100 text-text-100 shadow-sm")}>
        <Laptop className="h-3.5 w-3.5" />
        {t.thisComputer}
      </button>
      <button type="button" role="radio" aria-checked={false} disabled className="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] text-text-400 cursor-not-allowed">
        <Cloud className="h-3.5 w-3.5" />
        {t.cloud}
        <span className="rounded-[4px] bg-bg-300 px-1 text-[10.5px] text-text-300">{t.soon}</span>
      </button>
    </div>
  );
}
