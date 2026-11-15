import { useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { APPEARANCE_EVENT } from "@/lib/appearance";
import { isNewTerminalShortcut, isTerminalShortcut, NEW_TERMINAL_EVENT } from "@/lib/terminalShortcut";
import { loadReloadState, saveReloadState } from "@/lib/reloadState";
import { useTranslations } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { subscribeTerminalAdoptions, takeTerminalAdoptions } from "@/lib/terminalRun";
import { keepUnless, openTerminal, TerminalOutputGate } from "./terminalSession";

// ANSI colors tuned for a light background (VS Code Light+), so yellow/white output stays readable.
const LIGHT_ANSI: ITheme = {
  black: "#000000",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

function terminalTheme(): { theme: ITheme; minimumContrastRatio: number } {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  // Same thumb colours as the app's .custom-scrollbar.
  const scrollbar: ITheme = {
    scrollbarSliderBackground: v("--bg-300", "#dddddd"),
    scrollbarSliderHoverBackground: v("--text-400", "#999999"),
    scrollbarSliderActiveBackground: v("--text-400", "#999999"),
  };
  if (root.classList.contains("dark")) {
    return {
      theme: { ...scrollbar, background: "#1a1a18", foreground: "#e4e4e4", cursor: "#e4e4e4", selectionBackground: "#3a3a38" },
      minimumContrastRatio: 1,
    };
  }
  const fg = v("--text-100", "#1f1e1d");
  return {
    theme: { ...LIGHT_ANSI, ...scrollbar, background: v("--bg-100", "#ffffff"), foreground: fg, cursor: fg, selectionBackground: v("--bg-300", "#dddddd") },
    minimumContrastRatio: 4.5,
  };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Where a tab keeps its shell's id: lets a reload pick the shell up, and closing ask about it.
const paneKey = (workspace: string | null, tabId: number) => `terminal:${workspace ?? ""}:${tabId}`;

function TerminalPane({ workspace, tabId, active }: { workspace: string | null; tabId: number; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let termId = "";
    const reloadKey = paneKey(workspace, tabId);
    const unlisteners: Array<() => void> = [];

    const codeFont = () => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue("--code-font")
        .trim();
      return v || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    };

    const term = new XTerm({
      fontFamily: codeFont(),
      fontSize: 13,
      cursorBlink: true,
      scrollback: 1000,
      // xterm sizes its scrollbar from the overview ruler's width (14px by default); 6px matches
      // the thin scrollbars elsewhere in the app.
      overviewRuler: { width: 6 },
      ...terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    // Let Ctrl+` (close the terminal) and Ctrl+Shift+` (new tab) through to the app instead of
    // typing them into the shell.
    term.attachCustomKeyEventHandler((e) => !isTerminalShortcut(e) && !isNewTerminalShortcut(e));

    term.onData((data) => {
      if (termId) void invoke("term_write", { id: termId, data });
    });

    let lastRows = 0;
    let lastCols = 0;

    const applyResize = () => {
      try { fit.fit(); } catch { return; }

      if (!termId || (term.rows === lastRows && term.cols === lastCols)) return;
      lastRows = term.rows;
      lastCols = term.cols;
      void invoke("term_resize", { id: termId, rows: term.rows, cols: term.cols });
    };

    const onAppearance = () => {
      term.options.fontFamily = codeFont();
      applyResize();
    };
    window.addEventListener(APPEARANCE_EVENT, onAppearance);
    unlisteners.push(() => window.removeEventListener(APPEARANCE_EVENT, onAppearance));

    // applyTheme toggles `.dark` and rewrites the palette vars on <html> (also during theme previews).
    const themeObserver = new MutationObserver(() => {
      const { theme, minimumContrastRatio } = terminalTheme();
      term.options.theme = theme;
      term.options.minimumContrastRatio = minimumContrastRatio;
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    unlisteners.push(() => themeObserver.disconnect());

    requestAnimationFrame(() => {
      if (disposed) return;
      try { fit.fit(); } catch {  }
      void (async () => {
        const isDisposed = () => disposed;
        const output = new TerminalOutputGate((data) => term.write(b64ToBytes(data)));
        keepUnless(
          isDisposed,
          unlisteners,
          await listen<{ id: string; data: string }>("term-output", (e) => {
            if (!disposed) output.receive(e.payload.id, e.payload.data);
          }),
        );
        keepUnless(
          isDisposed,
          unlisteners,
          await listen<{ id: string; code: number | null }>("term-exit", (e) => {
            if (e.payload.id === termId && !disposed) {
              term.write(`\r\n\x1b[90m[process exited${e.payload.code != null ? ` (${e.payload.code})` : ""}]\x1b[0m\r\n`);
            }
          }),
        );
        if (disposed) return;
        try {
          lastRows = term.rows;
          lastCols = term.cols;
          // After a reload the shell (and a dev server in it) is still running: pick it up.
          const saved = loadReloadState<string>(reloadKey);
          const scrollback = saved ? await invoke<string | null>("term_attach", { id: saved }).catch(() => null) : null;
          if (disposed) return;
          if (saved && scrollback !== null) {
            termId = saved;
            term.write(b64ToBytes(scrollback));
            output.start(termId);
            void invoke("term_resize", { id: termId, rows: term.rows, cols: term.cols });
          } else {
            const opened = await openTerminal(invoke, { cwd: workspace ?? null, rows: term.rows, cols: term.cols }, isDisposed);
            if (!opened) return;
            termId = opened;
            output.start(termId);
          }
          saveReloadState(reloadKey, termId);
        } catch (err) {
          term.write(`\x1b[31m${String(err)}\x1b[0m\r\n`);
        }
      })();
    });

    const ro = new ResizeObserver(() => applyResize());
    ro.observe(host);

    // A reload tears the page down without running this cleanup, so the shell lives on; only
    // closing the terminal for real (its tab, or another folder) ends it.
    return () => {
      disposed = true;
      ro.disconnect();
      unlisteners.forEach((u) => u());
      if (termId) {
        void invoke("term_close", { id: termId });
        saveReloadState(reloadKey, null);
      }
      termRef.current = null;
      term.dispose();
    };
  }, [workspace, tabId]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  return (
    // The padding sits on the wrapper, not on the host: FitAddon measures the host's height with
    // its padding included, so padding there made it fit one row too many and cut off the prompt.
    <div className="flex flex-col h-full px-2 pt-2 pb-3 bg-bg-100 dark:bg-[#1a1a18]">
      <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}

const tabsKey = (workspace: string | null) => `terminalTabs:${workspace ?? ""}`;

/** Several shells side by side, as tabs (like the preview's browser tabs). One per project:
 *  the panel keeps each project's terminals running while another project is shown, so
 *  `visible` says whether this is the one on screen. */
export function TerminalView({
  workspace,
  onClose,
  visible = true,
  onToggleMaximize,
  maximized = false,
}: {
  workspace: string | null;
  onClose: () => void;
  visible?: boolean;
  onToggleMaximize?: () => void;
  maximized?: boolean;
}) {
  const tAll = useTranslations();
  const t = tAll.views;
  const [confirm, setConfirm] = useState<{ id: number; process: string } | null>(null);
  const [tabs, setTabs] = useState<number[]>(() => {
    const saved = loadReloadState<{ tabs: number[] }>(tabsKey(workspace));
    return saved?.tabs?.length ? saved.tabs : [1];
  });
  const [activeId, setActiveId] = useState<number>(() => {
    const saved = loadReloadState<{ active: number }>(tabsKey(workspace));
    return saved && tabs.includes(saved.active) ? saved.active : tabs[0];
  });
  useEffect(() => saveReloadState(tabsKey(workspace), { tabs, active: activeId }), [workspace, tabs, activeId]);

  // Ids are only keys for React and for the shell's reload state; tabs are labelled by position.
  const nextId = () => Math.max(0, ...tabs) + 1;

  const newTab = () => {
    const id = nextId();
    setTabs((list) => [...list, id]);
    setActiveId(id);
  };
  const newTabRef = useRef(newTab);
  useEffect(() => { newTabRef.current = newTab; });

  // Only the project on screen opens the new tab.
  useEffect(() => {
    if (!visible) return;
    const onNew = () => newTabRef.current();
    window.addEventListener(NEW_TERMINAL_EVENT, onNew);
    return () => window.removeEventListener(NEW_TERMINAL_EVENT, onNew);
  }, [visible]);

  const closeTab = (id: number) => {
    const i = tabs.indexOf(id);
    const rest = tabs.filter((x) => x !== id);
    if (rest.length === 0) {
      // Closing the last one hides the panel; the next open finds a fresh shell waiting.
      const fresh = nextId();
      setTabs([fresh]);
      setActiveId(fresh);
      onClose();
      return;
    }
    setTabs(rest);
    if (id === activeId) setActiveId(rest[Math.max(0, i - 1)]);
  };

  // Shells started by the chat's Run buttons, handed over by "Open in terminal": shown as a tab
  // that attaches to the running shell (scrollback included), or brought forward if already one.
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; });
  useEffect(() => {
    if (!visible) return;
    const drain = () => {
      for (const termId of takeTerminalAdoptions()) {
        const list = tabsRef.current;
        const existing = list.find((id) => loadReloadState<string>(paneKey(workspace, id)) === termId);
        if (existing != null) { setActiveId(existing); continue; }
        const fresh = Math.max(0, ...list) + 1;
        // The pane reads this on mount and attaches instead of opening a new shell.
        saveReloadState(paneKey(workspace, fresh), termId);
        // The panel just opened for this: its only tab hasn't started a shell yet, so take its place
        // rather than leave an empty terminal next to it.
        const replace = list.length === 1 && !loadReloadState<string>(paneKey(workspace, list[0]));
        tabsRef.current = replace ? [fresh] : [...list, fresh];
        setTabs(tabsRef.current);
        setActiveId(fresh);
      }
    };
    drain();
    return subscribeTerminalAdoptions(drain);
  }, [visible, workspace]);

  // A dev server left running in the tab would be stopped (with its whole process tree), so ask.
  const requestClose = async (id: number) => {
    const termId = loadReloadState<string>(paneKey(workspace, id));
    const busy = termId ? await invoke<string | null>("term_busy", { id: termId }).catch(() => null) : null;
    if (busy) setConfirm({ id, process: busy });
    else closeTab(id);
  };

  const label = (i: number) => (tabs.length > 1 ? `${t.terminal} ${i + 1}` : t.terminal);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div role="tablist" className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
          {tabs.map((id, i) => {
            const on = id === activeId;
            return (
              <div
                key={id}
                role="tab"
                aria-selected={on}
                onClick={() => setActiveId(id)}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void requestClose(id); } }}
                className={cn(
                  "group flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-[6px] text-[12.5px] max-w-[11rem] shrink-0 cursor-default transition-colors",
                  on ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200/60",
                )}
              >
                <TerminalIcon className="w-3.5 h-3.5 shrink-0 text-text-400" />
                <span className="min-w-0 truncate">{label(i)}</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void requestClose(id); }}
                  aria-label={t.closeTab}
                  className={cn(
                    "shrink-0 p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300 transition-opacity",
                    on ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={newTab}
            aria-label={t.newTerminal}
            data-tooltip={t.newTerminal}
            data-tooltip-kbd="Ctrl+Shift+`"
            aria-keyshortcuts="Ctrl+Shift+`"
            className="shrink-0 p-1 rounded text-text-400 hover:text-text-100 hover:bg-bg-200"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {onToggleMaximize && (
            <button onClick={onToggleMaximize} aria-label={maximized ? t.showChat : t.diffExpandPanel} className="p-1.5 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200">
              {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          )}
          <button onClick={onClose} aria-label={t.close} className="p-1.5 rounded-[6px] text-text-400 hover:text-text-200 hover:bg-bg-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {tabs.map((id) => (
          <div key={id} className={cn("h-full", id !== activeId && "hidden")}>
            <TerminalPane workspace={workspace} tabId={id} active={visible && id === activeId} />
          </div>
        ))}
      </div>
      {confirm && (
        <ConfirmDialog
          title={t.closeTerminalTitle}
          message={t.closeTerminalMessage.replace("{process}", confirm.process)}
          confirmLabel={t.closeTerminal}
          cancelLabel={tAll.modals.cancel}
          danger
          onConfirm={() => { closeTab(confirm.id); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
