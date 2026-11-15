import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "@/lib/i18n";
import type { RewindPreview } from "@/lib/fileHistory";

export type RewindMode = "both" | "conversation" | "code";

/** Asks before rewinding to a user message, and what to restore: the code, the conversation or both. */
export function RewindDialog({
  prompt,
  preview,
  onConfirm,
  onCancel,
}: {
  prompt: string;
  /** What restoring the code would change; null while it is being worked out. */
  preview: RewindPreview | null;
  onConfirm: (mode: RewindMode) => void;
  onCancel: () => void;
}) {
  const tMsg = useTranslations().message;
  const [mode, setMode] = useState<RewindMode>("both");
  const [menuOpen, setMenuOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const hasCode = !!preview && preview.files > 0;
  const effectiveMode: RewindMode = preview && !hasCode ? "conversation" : mode;
  // What the rewind leaves alone matters when it touches the code, and when there's nothing else
  // to restore (then it's why nothing is).
  const showKept = !!preview?.kept.length && (!hasCode || effectiveMode !== "conversation");

  useEffect(() => {
    if (preview) confirmRef.current?.focus();
  }, [preview]);

  const modes: { id: RewindMode; label: string }[] = [
    { id: "both", label: tMsg.rewindBoth },
    { id: "conversation", label: tMsg.rewindConversation },
    { id: "code", label: tMsg.rewindCode },
  ];
  const current = modes.find((m) => m.id === effectiveMode)!;

  return (
    <Dialog open onClose={onCancel} role="alertdialog" stacked className="max-w-[400px]">
      <div
        className="px-5 pt-5"
        onClick={() => setMenuOpen(false)}
        // Escape closes the open menu first, then the dialog.
        onKeyDown={(e) => {
          if (e.key === "Escape" && menuOpen) {
            e.stopPropagation();
            setMenuOpen(false);
          }
        }}
      >
        <DialogTitle className="text-[15px] font-semibold">{tMsg.rewindTitle}</DialogTitle>
        {prompt.trim() && (
          <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words rounded-[8px] bg-[color:var(--user-bubble)] px-3.5 py-2.5 text-[13px] text-text-100">
            {prompt.trim()}
          </p>
        )}

        {hasCode && (
          <>
            <div className="mt-4 text-[13px] font-medium text-text-100">{tMsg.rewindRestore}</div>
            <div className="relative mt-1.5">
              <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((o) => !o);
                }}
                className="flex w-full items-center justify-between rounded-[6px] border border-bg-300 bg-bg-0 px-3 py-1.5 text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
              >
                {current.label}
                <ChevronDown className="w-3.5 h-3.5 text-text-400" />
              </button>
              {menuOpen && (
                <div
                  data-mod-menu
                  role="listbox"
                  className="absolute left-0 right-0 top-full z-10 mt-1 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-xl"
                >
                  {modes.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={m.id === effectiveMode}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMode(m.id);
                        setMenuOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[13px] text-text-100 hover:bg-bg-200",
                        m.id === effectiveMode && "bg-bg-200",
                      )}
                    >
                      {m.label}
                      {m.id === effectiveMode && <Check className="w-4 h-4 text-accent" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {hasCode && effectiveMode !== "conversation" && (
          <>
            <div className="mt-3 flex items-center gap-1.5 text-[12px] text-text-300">
              <span>{preview!.files === 1 ? tMsg.rewindFile : tMsg.rewindFiles.replace("{n}", String(preview!.files))}</span>
              <span className="text-text-500">·</span>
              <span className="rounded-[6px] bg-green-500/15 px-1.5 text-green-600 dark:text-green-400">+{preview!.added}</span>
              <span className="rounded-[6px] bg-red-500/15 px-1.5 text-red-600 dark:text-red-400">−{preview!.removed}</span>
            </div>
            {preview!.paths.length > 0 && (
              <ul className="mt-2 max-h-28 overflow-y-auto custom-scrollbar rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1.5 font-mono text-[11.5px] leading-5 text-text-300">
                {preview!.paths.map((p) => (
                  <li key={p} className="break-all">{p}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[12px] leading-relaxed text-text-400">{tMsg.rewindNote}</p>
          </>
        )}

        {showKept && (
          <>
            <p className="mt-3 text-[12px] leading-relaxed text-text-300">{tMsg.rewindKept}</p>
            <ul className="mt-1.5 max-h-28 overflow-y-auto custom-scrollbar rounded-[6px] border border-bg-300 bg-bg-0 px-2.5 py-1.5 font-mono text-[11.5px] leading-5 text-text-300">
              {preview!.kept.map((p) => (
                <li key={p} className="break-all">{p}</li>
              ))}
            </ul>
          </>
        )}

      </div>
      <DialogFooter className="px-5 pb-5 pt-5">
        <Button onClick={onCancel}>{tMsg.cancel}</Button>
        <Button ref={confirmRef} variant="primary" disabled={!preview} onClick={() => onConfirm(effectiveMode)}>
          {tMsg.rewind}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
