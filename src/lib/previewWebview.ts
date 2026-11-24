import { invoke } from "@/lib/ipc";

/** Where the preview serves local servers and HTML files (the `nyxspreview` protocol). Tauri
 *  serves custom protocols as http://<scheme>.localhost on Windows and Android, and as
 *  <scheme>://localhost on macOS and Linux. */
export const PREVIEW_ORIGIN =
  typeof navigator !== "undefined" && /Windows|Android/i.test(navigator.userAgent)
    ? "http://nyxspreview.localhost"
    : "nyxspreview://localhost";

/** The origin of the preview site a page at `url` comes from (each folder or server the preview
 *  serves has its own port on the preview host), or null for any other address. */
export function previewSite(url: string): string | null {
  if (!url.startsWith(PREVIEW_ORIGIN)) return null;
  const port = /^:(\d+)(?=[/?#]|$)/.exec(url.slice(PREVIEW_ORIGIN.length));
  if (!port && !/^([/?#]|$)/.test(url.slice(PREVIEW_ORIGIN.length))) return null;
  return PREVIEW_ORIGIN + (port ? port[0] : "");
}

/** The target for postMessage to the preview page loaded from `src`. WebKit may give
 *  custom-scheme pages an opaque origin that no target string matches, so there it has to be
 *  "*"; answers are still checked by the window they come from. */
export function previewMessageTarget(src: string): string {
  if (!PREVIEW_ORIGIN.startsWith("http")) return "*";
  return previewSite(src) ?? PREVIEW_ORIGIN;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Every browser tab has its own native webview, named by the tab's id.

/** Each tab's number for the latest address it asked its page to open. The page sends it back
 *  with every report of where it went (`preview-nav`), so a report about a page the tab has
 *  already left is recognized and dropped. */
const tabNav = new Map<string, number>();

/** Starts a new navigation of the tab: reports from before it no longer count. */
export function nextPreviewNav(tab: string): number {
  const n = (tabNav.get(tab) ?? 0) + 1;
  tabNav.set(tab, n);
  return n;
}

export function currentPreviewNav(tab: string): number {
  return tabNav.get(tab) ?? 0;
}

/** What the tab's page says after it moves on its own (a link, a form, a redirect, a script). */
export interface PreviewNavReport {
  tab: string;
  url: string;
  nav: number;
  /** `history.length` in the page. */
  length: number;
  /** From the page's own history; null where the webview can't tell (WebKit). */
  canBack: boolean | null;
  canForward: boolean | null;
}

/** The tab's last command to its page, settled or not. */
const tabOps = new Map<string, Promise<void>>();

/** Runs the tab's commands one after the other. Commands run concurrently in the backend, so a
 *  hide sent while an open was still under way could land first, and the open then showed the
 *  page with its old bounds over the chat, with the panel already closed. A command with none
 *  before it starts right away. */
function inOrder<T>(tab: string, op: () => Promise<T>): Promise<T> {
  const before = tabOps.get(tab);
  const run = before ? before.then(op) : op();
  const done = run.then(() => undefined, () => undefined);
  tabOps.set(tab, done);
  void done.then(() => { if (tabOps.get(tab) === done) tabOps.delete(tab); });
  return run;
}

/** `profile` picks where the site's cookies live: "shared", "private" or a per-project key.
 *  `hidden` loads the page without showing it (a chat's browser that isn't on screen). */
export async function openPreviewWebview(tab: string, url: string, b: Bounds, profile?: string, hidden = false): Promise<void> {
  const nav = currentPreviewNav(tab);
  await inOrder(tab, () => invoke("preview_open", { tab, url, x: b.x, y: b.y, width: b.width, height: b.height, profile, hidden, nav }));
}

/** Back (-1) or forward (1) in the tab's page's own history. */
export async function goPreviewHistory(tab: string, delta: number): Promise<void> {
  await invoke("preview_history", { tab, delta });
}

/** Each tab's bounds on their way to its page, and the newest ones waiting for them to land. */
const boundsQueue = new Map<string, { sending: Bounds; next: Bounds | null }>();

const sameBounds = (a: Bounds, b: Bounds) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Moves the tab's page to `b`. One move per tab is under way at a time and only the newest one
 *  waits: commands run concurrently in the backend, so during a fast drag older bounds could
 *  land after newer ones and leave the page outside its box. */
export function setPreviewWebviewBounds(tab: string, b: Bounds): void {
  const queued = boundsQueue.get(tab);
  if (queued) {
    queued.next = sameBounds(queued.sending, b) ? null : b;
    return;
  }
  const entry = { sending: b, next: null as Bounds | null };
  boundsQueue.set(tab, entry);
  void (async () => {
    for (;;) {
      const { x, y, width, height } = entry.sending;
      await inOrder(tab, () => invoke("preview_set_bounds", { tab, x, y, width, height })).catch(() => undefined);
      if (!entry.next) break;
      entry.sending = entry.next;
      entry.next = null;
    }
    boundsQueue.delete(tab);
  })();
}

/** Hides the tab's page but keeps it loaded, for a tab in the background. */
export async function hidePreviewWebview(tab: string): Promise<void> {
  await inOrder(tab, () => invoke("preview_hide", { tab }));
}

export async function reloadPreviewWebview(tab: string): Promise<void> {
  await invoke("preview_reload", { tab });
}

export async function closePreviewWebview(tab: string): Promise<void> {
  await inOrder(tab, () => invoke("preview_close", { tab }));
}
