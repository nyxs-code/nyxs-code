import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUp, FolderGit2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import { loadWorkspace, workspaceName } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { isComposingKey } from "@/lib/imeKeys";

const MAX_ROWS = 4;

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-bg-300 bg-bg-200 px-1 py-px font-sans text-[10px] text-text-300">{children}</kbd>
  );
}

export function QuickWindow() {
  const t = useTranslations().quick;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [workspace, setWorkspace] = useState(() => loadWorkspace());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const unlistenShown = listen("quick:shown", () => {
      setText("");
      setSending(false);
      setWorkspace(loadWorkspace());
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) void invoke("quick_hide");
    });
    return () => {
      void unlistenShown.then((off) => off());
      void unlistenFocus.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  }, [text]);

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      await invoke("quick_submit", { prompt });
      setText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-screen w-screen items-start justify-center p-3">
      <div className="w-full rounded-[8px] border border-bg-300 bg-bg-100 shadow-2xl">
        <div className="flex items-end gap-3 px-4 pt-4 pb-3">
          <img src="/logo.png" alt="" className="mb-0.5 h-6 w-6 shrink-0 select-none" draggable={false} />
          <textarea
            ref={inputRef}
            autoFocus
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isComposingKey(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                void invoke("quick_hide");
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={t.placeholder}
            className="max-h-32 flex-1 resize-none overflow-y-auto custom-scrollbar bg-transparent text-[16px] leading-[22px] text-text-100 placeholder:text-text-400 outline-none"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim() || sending}
            aria-label={t.hintSend}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
              text.trim() ? "bg-accent text-bg-0 hover:bg-accent-hover" : "bg-bg-200 text-text-500",
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-3 border-t border-bg-300/70 px-4 py-2 text-[11px] text-text-400">
          {workspace && (
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <FolderGit2 className="h-3 w-3 shrink-0" />
              {workspaceName(workspace)}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1"><Kbd>Enter</Kbd> {t.hintSend}</span>
          <span className="inline-flex items-center gap-1"><Kbd>Shift+Enter</Kbd> {t.hintNewline}</span>
          <span className="inline-flex items-center gap-1"><Kbd>Esc</Kbd> {t.hintClose}</span>
        </div>
      </div>
    </div>
  );
}
