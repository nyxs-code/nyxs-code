/**
 * On macOS the webview sometimes lets AppKit type a key's raw character instead of
 * performing its action: the arrows, Home, End and forward delete become private-use
 * code points (U+F700–U+F8FF), shown as boxes, and Delete becomes DEL (U+007F) instead
 * of deleting. Wry once filtered these (wry#769) and lost the fix (wry#1175 is open).
 * This guard cancels those insertions and does what the key meant.
 */

const KEY_CHAR = /[\u007F-]/;
const KEY_CHARS = /[\u007F-]/g;

const UP = "";
const DOWN = "";
const LEFT = "";
const RIGHT = "";
const FORWARD_DELETE = "";
const HOME = "";
const END = "";
const DEL = "\u007F";

export function hasKeyChars(s: string): boolean {
  return KEY_CHAR.test(s);
}

export function stripKeyChars(s: string): string {
  return s.replace(KEY_CHARS, "");
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The selection after a movement key in a text field, or null when `key` isn't a movement. */
export function caretFor(
  key: string,
  value: string,
  start: number,
  end: number,
  extend: boolean,
): { start: number; end: number } | null {
  const collapsed = start === end;
  const lineStart = (pos: number) => value.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (pos: number) => {
    const i = value.indexOf("\n", pos);
    return i < 0 ? value.length : i;
  };
  // Steps over a whole emoji (a surrogate pair), not half of it.
  const back = (pos: number) => Math.max(0, pos - (pos >= 2 && isLowSurrogate(value.charCodeAt(pos - 1)) ? 2 : 1));
  const forward = (pos: number) => Math.min(value.length, pos + (isLowSurrogate(value.charCodeAt(pos + 1)) ? 2 : 1));

  switch (key) {
    case LEFT:
      if (extend) return { start: back(start), end };
      return collapsed ? { start: back(start), end: back(start) } : { start, end: start };
    case RIGHT:
      if (extend) return { start, end: forward(end) };
      return collapsed ? { start: forward(end), end: forward(end) } : { start: end, end };
    case HOME:
      return extend ? { start: lineStart(start), end } : { start: lineStart(start), end: lineStart(start) };
    case END:
      return extend ? { start, end: lineEnd(end) } : { start: lineEnd(end), end: lineEnd(end) };
    case UP: {
      // Same column on the line above; on the first line (and in single-line fields), the start.
      const ls = lineStart(start);
      const pos = ls === 0 ? 0 : Math.min(lineStart(ls - 1) + (start - ls), ls - 1);
      return extend ? { start: pos, end } : { start: pos, end: pos };
    }
    case DOWN: {
      const le = lineEnd(end);
      const pos = le === value.length ? value.length : Math.min(le + 1 + (end - lineStart(end)), lineEnd(le + 1));
      return extend ? { start, end: pos } : { start: pos, end: pos };
    }
    default:
      return null;
  }
}

const SELECTION_MOVES: Record<string, [direction: "backward" | "forward", granularity: "character" | "line" | "lineboundary"]> = {
  [LEFT]: ["backward", "character"],
  [RIGHT]: ["forward", "character"],
  [UP]: ["backward", "line"],
  [DOWN]: ["forward", "line"],
  [HOME]: ["backward", "lineboundary"],
  [END]: ["forward", "lineboundary"],
};

export function installMacKeyGuard(): void {
  let shift = false;
  document.addEventListener("keydown", (e) => { shift = e.shiftKey; }, true);
  document.addEventListener(
    "beforeinput",
    (e) => {
      const data = (e as InputEvent).data;
      if (!data || !hasKeyChars(data)) return;
      e.preventDefault();
      const clean = stripKeyChars(data);
      if (clean) {
        document.execCommand("insertText", false, clean);
        return;
      }
      if (data.length !== 1) return;
      if (data === DEL || data === FORWARD_DELETE) {
        document.execCommand(data === DEL ? "delete" : "forwardDelete");
        return;
      }
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const { selectionStart: start, selectionEnd: end } = el;
        if (start === null || end === null) return;
        const next = caretFor(data, el.value, start, end, shift);
        if (next) el.setSelectionRange(next.start, next.end);
        return;
      }
      const move = SELECTION_MOVES[data];
      if (move) window.getSelection()?.modify(shift ? "extend" : "move", move[0], move[1]);
    },
    true,
  );
}
