/** Text the user highlighted in a chat message, to find their place again while reading.
 *
 *  A highlight is stored by what it says, not by where it sits: the quote plus a little of the
 *  text around it. The rendered message changes under it (a folded trace opens, a tool chip's
 *  label updates), so character offsets alone would drift; the context picks the right
 *  occurrence when the quote appears more than once. It is drawn with the CSS Custom Highlight
 *  API, which paints ranges without touching the message's DOM. */

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "orange", "red"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** The swatch and the minimap tick. The highlight itself is a softer version, in index.css. */
export const HIGHLIGHT_SWATCH: Record<HighlightColor, string> = {
  yellow: "#ffd000",
  green: "#00d45a",
  blue: "#1e6fff",
  pink: "#ff2d95",
  orange: "#ff6a00",
  red: "#ff1f1f",
};

export interface TextHighlight {
  id: string;
  color: HighlightColor;
  quote: string;
  /** Up to CONTEXT characters before and after the quote, to tell repeated quotes apart. */
  prefix: string;
  suffix: string;
  createdAt: number;
}

const CONTEXT = 32;

/** The rendered text of a message (what its highlights are matched against). */
export const BODY_SELECTOR = "[data-message-body]";

export function bodyOf(container: ParentNode, messageId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"] ${BODY_SELECTOR}`);
}

/** Text offset of a boundary point inside `root`, counted the way Range.toString() counts. */
function offsetIn(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

export interface SelectionSpot {
  messageId: string;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}

/** Where a selection sits, when it lies inside one message's body. */
export function spotOfRange(range: Range): SelectionSpot | null {
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const endEl = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const body = startEl?.closest<HTMLElement>(BODY_SELECTOR);
  if (!body || body !== endEl?.closest(BODY_SELECTOR)) return null;
  const messageId = body.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
  if (!messageId) return null;
  const text = body.textContent ?? "";
  let start = offsetIn(body, range.startContainer, range.startOffset);
  let end = offsetIn(body, range.endContainer, range.endOffset);
  // Leading and trailing spaces of a drag aren't part of what was meant.
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  return {
    messageId,
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

export function newHighlight(spot: SelectionSpot, color: HighlightColor): TextHighlight {
  const now = Date.now();
  return {
    id: `hl-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    color,
    quote: spot.quote,
    prefix: spot.prefix,
    suffix: spot.suffix,
    createdAt: now,
  };
}

function sharedTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Where a highlight is in the message's text now: the occurrence of its quote whose
 *  surroundings match best. Null when the quote is gone. */
export function locate(text: string, h: Pick<TextHighlight, "quote" | "prefix" | "suffix">): { start: number; end: number } | null {
  if (!h.quote) return null;
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(h.quote); i !== -1; i = text.indexOf(h.quote, i + 1)) {
    const score = sharedTail(text.slice(Math.max(0, i - h.prefix.length), i), h.prefix) + sharedHead(text.slice(i + h.quote.length), h.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best === -1 ? null : { start: best, end: best + h.quote.length };
}

/** A DOM range over text offsets [start, end) of `root`. */
function rangeAt(root: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = (node as Text).data.length;
    if (!started && start < pos + len) {
      range.setStart(node, start - pos);
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

/** The highlights of a message that overlap [start, end) of its current text. */
export function overlapping(text: string, list: TextHighlight[], start: number, end: number): TextHighlight[] {
  return list.filter((h) => {
    const at = locate(text, h);
    return !!at && at.start < end && start < at.end;
  });
}

const supported = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** The ranges each chat on screen painted, by its container. The CSS highlight registry has one
 *  entry per color for the whole page, and two chats side by side would wipe each other's. */
const paintedBy = new Map<ParentNode, Record<HighlightColor, Range[]>>();

/** Puts every chat's ranges in the registry, one CSS highlight per color. */
function publish(): void {
  for (const container of paintedBy.keys()) {
    if ((container as Node).isConnected === false) paintedBy.delete(container);
  }
  for (const color of HIGHLIGHT_COLORS) {
    const name = `nyxs-hl-${color}`;
    const all = [...paintedBy.values()].flatMap((r) => r[color]);
    if (all.length) CSS.highlights.set(name, new Highlight(...all));
    else CSS.highlights.delete(name);
  }
}

/** Paints every highlight of a chat's messages on screen, next to other chats' highlights. */
export function paintHighlights(container: ParentNode, byMessage: Record<string, TextHighlight[] | undefined>): void {
  if (!supported()) return;
  const ranges = Object.fromEntries(HIGHLIGHT_COLORS.map((c) => [c, [] as Range[]])) as Record<HighlightColor, Range[]>;
  for (const [messageId, list] of Object.entries(byMessage)) {
    if (!list?.length) continue;
    const body = bodyOf(container, messageId);
    if (!body) continue;
    const text = body.textContent ?? "";
    for (const h of list) {
      const at = locate(text, h);
      const r = at && rangeAt(body, at.start, at.end);
      if (r) ranges[h.color]?.push(r);
    }
  }
  paintedBy.set(container, ranges);
  publish();
}

/** Takes a chat's highlights off the page (all chats' without one), leaving the others'. */
export function clearHighlights(container?: ParentNode): void {
  if (!supported()) return;
  if (container) paintedBy.delete(container);
  else paintedBy.clear();
  publish();
}

/** For the minimap: the color of each of your messages whose turn has something highlighted,
 *  in it or in the replies after it (up to your next message). The latest highlight wins. */
export function turnHighlightColors(
  messages: { id: string; role: string; highlights?: TextHighlight[] }[],
  isTurnStart: (m: { id: string; role: string }) => boolean,
): Record<string, HighlightColor> {
  const out: Record<string, HighlightColor> = {};
  let turn: string | null = null;
  let latest = -1;
  for (const m of messages) {
    if (isTurnStart(m)) {
      turn = m.id;
      latest = -1;
    }
    if (!turn) continue;
    for (const h of m.highlights ?? []) {
      if (h.createdAt > latest) {
        latest = h.createdAt;
        out[turn] = h.color;
      }
    }
  }
  return out;
}

const LAST_COLOR_KEY = "nyxs.highlightColor";

export function lastHighlightColor(): HighlightColor {
  try {
    const v = localStorage.getItem(LAST_COLOR_KEY);
    if (v && (HIGHLIGHT_COLORS as readonly string[]).includes(v)) return v as HighlightColor;
  } catch { /* storage unavailable */ }
  return "yellow";
}

export function rememberHighlightColor(color: HighlightColor): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, color);
  } catch { /* storage unavailable */ }
}
