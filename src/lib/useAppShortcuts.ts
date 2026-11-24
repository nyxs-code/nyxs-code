import { useEffect, type RefObject } from "react";
import type { ViewId } from "@/components/ViewsPanel";
import { isNewTerminalShortcut, isTerminalShortcut } from "@/lib/terminalShortcut";
import { cycleComposerEffort, openComposerMenu } from "@/lib/composerMenus";
import { cycleThemePreference } from "@/lib/theme";
import { cycleTranscriptView } from "@/lib/transcriptView";
import { toggleSideChat } from "@/lib/sideChat";

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

/** The app's keyboard shortcuts. The listeners are added once and call whatever actions the
 *  ref holds then; the caller fills it in an effect, so nothing here runs during render. */
export function useAppShortcuts(ref: RefObject<AppShortcutActions | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = ref.current;
      if (!a) return;
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
      if (!mod) return;
      // AltGr arrives as Ctrl+Alt on Windows and types characters (\ @ # | on a Spanish
      // keyboard): none of these shortcuts uses Alt, so it's never one of them.
      if (e.altKey || e.getModifierState?.("AltGraph")) return;
      // Session switching like Claude Code Desktop: Ctrl+Tab / Ctrl+Shift+Tab, and
      // Ctrl+Shift+] / [ by the key's place (its character changes with the layout and Shift).
      if (e.key === "Tab" && !e.altKey) {
        e.preventDefault();
        a.cycleSession(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.shiftKey && !e.altKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
        e.preventDefault();
        a.cycleSession(e.code === "BracketRight" ? 1 : -1);
        return;
      }
      // Punctuation by the key's place (the US one), so the same key works on every layout, or
      // by its character where the layout needs Shift to type it (Spanish: / is Shift+7).
      const punctuation: [string, string, () => void][] = [
        ["Slash", "/", a.toggleShortcuts],
        ["Comma", ",", a.toggleSettings],
        ["Semicolon", ";", a.toggleSidebar],
        ["Backslash", "\\", a.closeViews],
      ];
      const hit = (!e.shiftKey ? punctuation.find(([code]) => code === e.code) : undefined) ?? punctuation.find(([, char]) => char === e.key);
      if (hit) {
        e.preventDefault();
        hit[2]();
        return;
      }
      const k = e.key.toLowerCase();
      if (e.shiftKey) {
        switch (k) {
          case "d": e.preventDefault(); a.toggleView("diff"); return;
          case "b": e.preventDefault(); a.toggleView("preview"); return;
          case "f": e.preventDefault(); a.toggleView("files"); return;
          case "l": e.preventDefault(); cycleThemePreference(); return;
          case "m": e.preventDefault(); openComposerMenu("mode"); return;
          case "i": e.preventDefault(); openComposerMenu("model"); return;
          case "e": e.preventDefault(); cycleComposerEffort(); return;
        }
        return;
      }
      switch (e.key) {
        case "n": case "N": e.preventDefault(); a.newChat(); return;
        case "f": case "F": e.preventDefault(); a.openFind(); return;
        case "k": case "K": e.preventDefault(); a.toggleSessionSearch(); return;
        case "o": case "O": e.preventDefault(); cycleTranscriptView(); return;
        // The side chat; Claude Code Desktop's Ctrl+; is the sidebar here.
        case "j": case "J": e.preventDefault(); toggleSideChat(); return;
        // Like Claude Code Desktop: the open chat's running commands go on in the background.
        // Only taken when there is one, so Ctrl+B stays the editor's and terminal's otherwise.
        case "b": case "B":
          if (e.target instanceof HTMLElement && e.target.closest(".xterm")) return;
          if (a.moveToBackground()) e.preventDefault();
          return;
      }
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
