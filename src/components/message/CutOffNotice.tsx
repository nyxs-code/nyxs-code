import { Play, PowerOff } from "lucide-react";
import { useTranslations } from "@/lib/i18n";

/** Under a reply the app cut by closing or crashing, when it didn't carry it on by itself. The
 *  button shows while the reply is the chat's last and nothing runs (`onContinue`). */
export function CutOffNotice({ onContinue }: { onContinue?: () => void }) {
  const t = useTranslations().chatUi;
  return (
    <div role="status" className="mt-2 flex items-center gap-2 rounded-[8px] bg-bg-100 px-3 py-1.5 text-[13px] text-text-400">
      <PowerOff className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{t.replyCutOff}</span>
      {onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-bg-300 px-2 py-0.5 text-[12px] font-medium text-text-200 hover:bg-bg-200"
        >
          <Play className="h-3 w-3" />
          {t.continueReply}
        </button>
      )}
    </div>
  );
}
