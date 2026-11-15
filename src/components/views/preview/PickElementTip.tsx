import { useTranslations } from "@/lib/i18n";
import { PICK_SHORTCUT } from "./helpers";

/** What the element picker's button does, below it. A hole in the native webview lets it show
 *  over a website. */
export function PickElementTip() {
  const t = useTranslations().views;
  return (
    <div role="tooltip" data-webview-hole className="app-tooltip pointer-events-none absolute right-0 top-full mt-2 z-50 w-72 px-3 py-2 shadow-xl text-left">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[13px] font-semibold leading-snug">{t.selectElement}</span>
        <span className="shrink-0 text-[12px] leading-snug app-tooltip-muted">{PICK_SHORTCUT}</span>
      </div>
      <p className="mt-1 text-[12px] leading-snug app-tooltip-muted">{t.selectElementHint}</p>
    </div>
  );
}
