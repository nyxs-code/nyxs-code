import { AlertTriangle, Check, Cpu, Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { retryRuntime, STAGES, type RuntimeState } from "./runtimeState";

/** "Preparing the video engine": shown once, while the runtime installs. */
export function RuntimePreparing({ runtime }: { runtime: RuntimeState }) {
  const t = useTranslations().videoPanel;
  if (runtime.phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-red-500" />
        <p className="text-[13.5px] font-medium text-text-100">{t.runtimeFailed}</p>
        {runtime.error && <p className="max-h-40 max-w-md overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-text-400 custom-scrollbar">{runtime.error}</p>}
        <Button variant="secondary" className="mt-1" onClick={retryRuntime}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t.retry}
        </Button>
      </div>
    );
  }
  const current = runtime.stage ? STAGES.indexOf(runtime.stage) : -1;
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-1 flex items-center gap-2">
          <Cpu className="h-4 w-4 text-accent" />
          <p className="text-[13.5px] font-medium text-text-100">{t.runtimeTitle}</p>
        </div>
        <p className="mb-4 text-[12px] leading-relaxed text-text-400">{t.runtimeHint}</p>
        <div className="h-1 overflow-hidden rounded-full bg-bg-300">
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(3, Math.round(runtime.progress * 100))}%` }} />
        </div>
        <ol className="mt-4 space-y-2">
          {STAGES.map((s, i) => {
            const done = runtime.phase === "ready" || i < current;
            const active = runtime.phase === "installing" && i === current;
            return (
              <li key={s} className="flex items-center gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {done ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <span className="h-1.5 w-1.5 rounded-full bg-bg-400" />}
                </span>
                <span className={cn("text-[12.5px]", done || active ? "text-text-100" : "text-text-400")}>{s === "copying" ? t.runtimeCopying : s === "installing" ? t.runtimeInstalling : t.runtimeBrowser}</span>
              </li>
            );
          })}
        </ol>
        {runtime.line && <p className="mt-3 truncate font-mono text-[11px] text-text-400">{runtime.line}</p>}
      </div>
    </div>
  );
}
