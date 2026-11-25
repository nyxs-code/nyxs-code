import { useEffect, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { useAppearance } from "@/lib/appearance";
import { useTranslations } from "@/lib/i18n";
import { modHost } from "@/lib/mods/io";
import type { ModToast } from "@/lib/mods/types";

function Toast({ toast, closeLabel }: { toast: ModToast; closeLabel: string }) {
  const keep = useAppearance().keepPopups;
  useEffect(() => {
    // Settings › Keep popups on screen: it stays until closed.
    if (keep) return;
    const timer = setTimeout(() => modHost.dismissToast(toast.id), Math.max(1500, Math.min(60_000, toast.timeoutMs)));
    return () => clearTimeout(timer);
  }, [toast.id, toast.timeoutMs, keep]);
  return (
    <div role="status" className="flex items-start gap-2 rounded-[8px] border border-bg-300 bg-bg-100 px-3 py-2.5 shadow-2xl animate-fade-in">
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-text-200">{toast.text}</p>
      <button
        type="button"
        onClick={() => modHost.dismissToast(toast.id)}
        aria-label={closeLabel}
        className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200 hover:text-text-200"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The toasts mods raise (`$.ui.toast`), newest last, in the corner stack. */
export function ModToasts() {
  useSyncExternalStore(modHost.subscribe, modHost.getVersion);
  const closeLabel = useTranslations().mods.close;
  return (
    <>
      {modHost.toasts.slice(-4).map((t) => (
        <Toast key={t.id} toast={t} closeLabel={closeLabel} />
      ))}
    </>
  );
}
