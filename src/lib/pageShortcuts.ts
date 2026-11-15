/** A key typed in a page of the built-in browser, as the page's bridge passes it on. */
export interface PageKey {
  key: string;
  code: string;
  keyCode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The app's shortcuts that still work with the focus in a page, where the page gets the keys
 *  (the same list as `appShortcut` in src-tauri/src/agent/preview_agent.js): the element picker
 *  (Ctrl+Shift+S), switching sessions (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Shift+[ and ]), the side
 *  chat (Ctrl+J), the transcript view (Ctrl+O), session search (Ctrl+K), a new chat (Ctrl+N),
 *  a new browser tab (Ctrl+T), settings (Ctrl+,), the shortcuts list (Ctrl+/), the sidebar
 *  (Ctrl+;), closing the panels (Ctrl+\), the diff, browser and files panels (Ctrl+Shift+D, B,
 *  F) and the terminal (Ctrl+` and Ctrl+Shift+`). Left out: what a page means for itself
 *  (Escape, Ctrl+F, Alt+arrows for its own history) and what acts on the composer, which needs
 *  the focus there anyway (its mode, model and effort menus). */
export function isPageShortcut(k: PageKey): boolean {
  if (!(k.ctrlKey || k.metaKey)) return false;
  const key = k.key.toLowerCase();
  if (key === "tab" || key === "`" || key === "~" || k.code === "Backquote" || k.keyCode === 192) return true;
  if (k.shiftKey) return k.code === "BracketLeft" || k.code === "BracketRight" || ["s", "b", "d", "f"].includes(key);
  return ["j", "o", "k", "n", "t", ",", "/", ";", "\\"].includes(key);
}

/** The key in a page's message, if it is a well-formed app shortcut. A page can post anything,
 *  so nothing else (Escape stopping a reply, say) gets through. */
export function toPageKey(raw: unknown): PageKey | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.code !== "string" || typeof r.keyCode !== "number") return null;
  const k: PageKey = {
    key: r.key,
    code: r.code,
    keyCode: r.keyCode,
    shiftKey: r.shiftKey === true,
    ctrlKey: r.ctrlKey === true,
    metaKey: r.metaKey === true,
  };
  return isPageShortcut(k) ? k : null;
}

/** Does what the key does in the app, as if typed there: the app's own listeners get it. */
export function replayPageKey(k: PageKey, target: EventTarget = document.body ?? window): void {
  const e = new KeyboardEvent("keydown", {
    key: k.key,
    code: k.code,
    shiftKey: k.shiftKey,
    ctrlKey: k.ctrlKey,
    metaKey: k.metaKey,
    bubbles: true,
    cancelable: true,
  });
  // Not settable through the constructor, and the terminal's shortcut reads it on layouts
  // where "`" is a dead key.
  Object.defineProperty(e, "keyCode", { get: () => k.keyCode });
  target.dispatchEvent(e);
}
