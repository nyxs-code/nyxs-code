import { isRecordingShortcut, isShortcut } from "@/lib/keyBindings";

/** The terminal's shortcut (Ctrl+` by default, Cmd+` on macOS) toggles it, from any keyboard
 *  layout: see `isBackquoteKey` in keyBindings.ts for the keys that count as "`". */
export function isTerminalShortcut(e: KeyboardEvent): boolean {
  return !isRecordingShortcut() && isShortcut("toggleTerminal", e);
}

/** Ctrl+Shift+` (by default) opens another terminal tab, like VS Code. */
export function isNewTerminalShortcut(e: KeyboardEvent): boolean {
  return !isRecordingShortcut() && isShortcut("newTerminal", e);
}

/** Asks the terminal view for a new tab (sent by the app-wide Ctrl+Shift+` handler). */
export const NEW_TERMINAL_EVENT = "nyxs:new-terminal";
