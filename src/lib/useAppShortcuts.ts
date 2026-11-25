import { useEffect, type RefObject } from "react";
import type { ViewId } from "@/components/ViewsPanel";
import { isNewTerminalShortcut, isTerminalShortcut } from "@/lib/terminalShortcut";
import { cycleComposerEffort, openComposerMenu } from "@/lib/composerMenus";
import { cycleThemePreference } from "@/lib/theme";
import { cycleTranscriptView } from "@/lib/transcriptView";
import { toggleSideChat } from "@/lib/sideChat";
import { isRecordingShortcut, shortcutFor, type ShortcutId } from "@/lib/keyBindings";

export interface AppShortcutActions {
  /** A reply or `/compact` is running in the open chat (Escape stops it). */
  streaming: boolean;
  stop: () => void;
  newChat: () => void;
  toggleSettings: () => void;
  toggleShortcuts: () => void;
  openFind: () => void;
  toggleSessionSearch: () => void;
  toggleSidebar: () => void;
  closeViews: () => void;
  toggleView: (view: ViewId) => void;
  openNewTerminal: () => void;
  goBack: () => void;
  goForward: () => void;
  /** Opens the next (1) or previous (-1) session in Recents. */
  cycleSession: (step: 1 | -1) => void;
  /** Moves the open chat's running commands to the background; false when it has none. */
  moveToBackground: () => boolean;
}

/** What each changeable shortcut does. The terminal's two are caught on the way down (below)
 *  and the element picker's by the browser view. */
const ACTIONS: Partial<Record<ShortcutId, (a: AppShortcutActions) => void>> = {
  openShortcuts: (a) => a.toggleShortcuts(),
  openSettings: (a) => a.toggleSettings(),
  newSession: (a) => a.newChat(),
  find: (a) => a.openFind(),
  searchSessions: (a) => a.toggleSessionSearch(),
  toggleTheme: () => cycleThemePreference(),
  toggleDiff: (a) => a.toggleView("diff"),
  togglePreview: (a) => a.toggleView("preview"),
  toggleFiles: (a) => a.toggleView("files"),
  closePanel: (a) => a.closeViews(),
  toggleSidebar: (a) => a.toggleSidebar(),
  transcriptView: () => cycleTranscriptView(),
  sideChat: () => toggleSideChat(),
  moveToBackground: (a) => void a.moveToBackground(),
  modeMenu: () => openComposerMenu("mode"),
  modelMenu: () => openComposerMenu("model"),
  effort: () => cycleComposerEffort(),
};

/** The app's keyboard shortcuts. The listeners are added once and call whatever actions the
 *  ref holds then; the caller fills it in an effect, so nothing here runs during render. */
export function useAppShortcuts(ref: RefObject<AppShortcutActions | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      if (!a || isRecordingShortcut()) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (!a.streaming || e.defaultPrevented) return;
        const target = e.target instanceof HTMLElement ? e.target : null;
        const editing = target?.closest("input, textarea, select, [contenteditable='true']");
        if (editing && !target?.closest("[data-composer]")) return;
        if (document.querySelector("[role='dialog'], [aria-modal='true'], [data-composer-menu]")) return;
        a.stop();
        return;
      }
      // Alt+Left / Alt+Right walk the app's history, like a browser. Not while typing: there
      // (on macOS above all, Option+arrow) they move the caret by word.
      if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest("input, textarea, select"))) return;
        e.preventDefault();
        if (e.key === "ArrowLeft") a.goBack();
        else a.goForward();
        return;
      }
      // AltGr arrives as Ctrl+Alt on Windows and types characters (\ @ # | on a Spanish
      // keyboard): no shortcut uses Alt, so it's never one of them.
      if (e.altKey || e.getModifierState?.("AltGraph")) return;
      // Session switching like Claude Code Desktop: Ctrl+Tab / Ctrl+Shift+Tab, and
      // Ctrl+Shift+] / [ by the key's place (its character changes with the layout and Shift).
      if (mod && e.key === "Tab") {
        e.preventDefault();
        a.cycleSession(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault();
        a.cycleSession(e.code === "BracketRight" ? 1 : -1);
        return;
      }
      // The rest can be changed in Keyboard shortcuts (keyBindings.ts): Ctrl with a key, or an
      // F key. Anything else is typing.
      if (!mod && !/^F\d/.test(e.key)) return;
      const id = shortcutFor(e);
      if (!id) return;
      const run = ACTIONS[id];
      if (!run) return;
      if (id === "moveToBackground") {
        // Like Claude Code Desktop: the open chat's running commands go on in the background.
        // Only taken when there is one, so the key stays the editor's and terminal's otherwise.
        if (e.target instanceof HTMLElement && e.target.closest(".xterm")) return;
        if (a.moveToBackground()) e.preventDefault();
        return;
      }
      e.preventDefault();
      run(a);
    };
    // Ctrl+` is caught on the way down (capture), before the focused element — the terminal
    // itself, an input — can swallow it, so it toggles the terminal from anywhere.
    const onTerminalKey = (e: KeyboardEvent) => {
      if (isNewTerminalShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        ref.current?.openNewTerminal();
        return;
      }
      if (!isTerminalShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      ref.current?.toggleView("terminal");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onTerminalKey, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onTerminalKey, true);
    };
  }, [ref]);
}
