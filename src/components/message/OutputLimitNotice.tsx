import { TriangleAlert } from "lucide-react";
import type { OutputLimitHit } from "@/lib/agentTurn";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SETTING = "generation.maxOutputTokens";

/** Under a reply where the model ran out of output tokens: cut off (a warning), or cut while
 *  thinking and recovered by the one retry (a quieter note). */
export function OutputLimitNotice({ hit }: { hit: OutputLimitHit }) {
  const t = useTranslations().chatUi;
  const [before, after = ""] = t.outputLimitHint.replace("{limit}", hit.limit?.toLocaleString() ?? "").split("{setting}");
  return (
    <div
      role="status"
      className={cn(
        "mt-2 flex items-start gap-2 rounded-[8px] px-3 py-1.5 text-[13px]",
        hit.cut ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : "bg-bg-100 text-text-400",
      )}
    >
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        {hit.cut ? t.outputLimitCut : t.outputLimitRetried}
        {hit.limit !== undefined && (
          <>
            {" "}
            {before}
            <code className="rounded-[6px] bg-bg-200 px-1 py-px font-mono text-[12px]">{SETTING}</code>
            {after}
          </>
        )}
      </span>
    </div>
  );
}
