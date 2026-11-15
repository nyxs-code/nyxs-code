import type { PreviewNavReport } from "@/lib/previewWebview";

/** A tab's back/forward list and where it is in it. */
export interface PageHistory {
  list: string[];
  i: number;
}

/** What the tab remembers between its page's reports. */
export interface NavContext {
  /** The page's previous report, to tell a new entry in its history from a replaced one. */
  last: Pick<PreviewNavReport, "length" | "canForward"> | null;
  /** The tab just asked for an address: wherever the page lands first (after redirects) is
   *  that entry, not a new one, or Back would lead into the redirect again. */
  replaceNext: boolean;
}

/** Adds an address the tab opened itself (typed, from the chat, a server), dropping what was
 *  ahead of the current one. Opening the current address again adds nothing. */
export function pushAddress(h: PageHistory, url: string): PageHistory {
  const list = h.list.slice(0, h.i + 1);
  if (list[list.length - 1] === url) return h;
  return { list: [...list, url], i: list.length };
}

function replaceCurrent(h: PageHistory, url: string): PageHistory {
  if (h.i < 0) return pushAddress(h, url);
  const list = [...h.list];
  list[h.i] = url;
  return { list, i: h.i };
}

/** The tab's history after its page reports where it went on its own. The same address again
 *  (a reload, the tab's own navigation arriving) changes nothing; a step to the entry before
 *  or after is Back or Forward; an address replaced in place (a redirect right after the tab
 *  asked for a page, or `history.replaceState`, which leaves the page's history as long as it
 *  was) takes the current entry's place; anything else is a new entry. */
export function applyNavReport(h: PageHistory, r: Pick<PreviewNavReport, "url" | "length" | "canForward">, ctx: NavContext): PageHistory {
  if (h.list[h.i] === r.url) return h;
  if (ctx.replaceNext) return replaceCurrent(h, r.url);
  if (h.i > 0 && h.list[h.i - 1] === r.url) return { ...h, i: h.i - 1 };
  if (h.list[h.i + 1] === r.url) return { ...h, i: h.i + 1 };
  if (ctx.last && r.length === ctx.last.length && r.canForward === ctx.last.canForward) return replaceCurrent(h, r.url);
  return pushAddress(h, r.url);
}
