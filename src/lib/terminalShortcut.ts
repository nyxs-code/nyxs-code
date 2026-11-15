/** Ctrl+` (Cmd+` on macOS) toggles the terminal, from any keyboard layout. "`" is a dead
 *  key on Spanish and other layouts, so the key that sits where "`" is on a US keyboard also
 *  counts: keyCode 192 (VK_OEM_3) is Ñ on a Spanish keyboard, which is why VS Code shows
 *  "Ctrl+Ñ" there. The physical key left of 1 (º) and the "`^" key next to P count too. */
export function isTerminalShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  return isBackquoteKey(e);
}

/** Ctrl+Shift+` opens another terminal tab, like VS Code. Same key as above, plus Shift
 *  (which turns "`" into "~" on a US keyboard, hence matching the physical key too). */
export function isNewTerminalShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return false;
  return isBackquoteKey(e) || e.key === "~";
}

function isBackquoteKey(e: KeyboardEvent): boolean {
  return (
    e.key === "`" ||
    e.code === "Backquote" ||
    e.keyCode === 192 ||
    (e.key === "Dead" && e.code === "BracketLeft")
  );
}

/** Asks the terminal view for a new tab (sent by the app-wide Ctrl+Shift+` handler). */
export const NEW_TERMINAL_EVENT = "nyxs:new-terminal";
