import type { Bounds } from "@/lib/previewWebview";
import { pickAgentTab, type BrowserTabInfo } from "@/lib/previewTabs";

/** What a tab of the built-in browser shows. */
export interface PreviewPageInfo {
  /** "local": a page served through the preview (dev servers, HTML files). "external": a
   *  website in the tab's native webview. The agent can read and drive both. */
  kind: "local" | "external" | "file" | "empty";
  url: string;
}

/** A tab of the built-in browser, as the agent's browser tools see it. */
export interface PreviewController {
  info(): PreviewPageInfo;
  /** Opens an address and resolves once the page has loaded, with a short note. */
  navigate(url: string): Promise<string>;
  reload(): Promise<string>;
  /** Runs one command of the bridge injected into local pages (see preview_agent.js). */
  exec(cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<string>;
  /** Where the page sits in the window, for screenshots. */
  bounds(): Bounds | null;
  /** A PNG (base64) of the window area `b` over the page, drawn by the page's own webview, so
   *  a window over Nyxs doesn't show in it. */
  capture(b: Bounds): Promise<string>;
  /** Whether the page is on screen (its chat is the one shown, the panel is open, the tab in front). */
  onScreen(): boolean;
}

/** What a chat's browser (PreviewView) lets the agent's tools do with its tabs. */
export interface PreviewBrowser {
  workspace(): string | null;
  isAgentTab(tab: string): boolean;
  /** Opens a tab for the agent, in front, and says its id; it registers itself once mounted. */
  openAgentTab(): string;
  /** The agent starts using a tab that was empty: from now on it is the agent's. */
  claimTab(tab: string): void;
  focusTab(tab: string): void;
}

/** Asks the app to bring the preview to the front. `detail.chat` names the chat whose browser
 *  the agent wants: shown when it is the chat on screen, started out of sight otherwise. */
export const OPEN_PREVIEW_EVENT = "nyxs:open-preview";

// Each chat has a browser of its own (a "slot", see useChatViews). An agent drives the browser
// of the chat it runs in: driving the one on screen let a chat working in the background open
// its pages (the user's mail, say) in whatever chat or project the user was looking at.

interface LiveBrowser {
  tabs: Map<string, PreviewController>;
  front: string | null;
  /** Whether the browser is the one on screen. */
  visible: boolean;
  handle: PreviewBrowser | null;
  /** The tab the agent of the chat works in this turn. The user moving to another tab meanwhile
   *  must not send the agent's clicks and keys to the page they went to. */
  pinned: string | null;
}

const bySlot = new Map<string, LiveBrowser>();
/** Which browser each chat has, as useChatViews keeps it. */
let slotOfChat: Record<string, string> = {};
const waiters = new Set<() => void>();

function wakeAll(): void {
  for (const wake of [...waiters]) wake();
}

function liveBrowser(slot: string): LiveBrowser {
  let browser = bySlot.get(slot);
  if (!browser) {
    browser = { tabs: new Map(), front: null, visible: false, handle: null, pinned: null };
    bySlot.set(slot, browser);
  }
  return browser;
}

function forgetIfUnused(slot: string): void {
  const browser = bySlot.get(slot);
  if (browser && !browser.tabs.size && !browser.handle) bySlot.delete(slot);
}

/** A chat's browser offers its tabs to the agent's tools while it is mounted. */
export function registerPreviewBrowser(slot: string, handle: PreviewBrowser): () => void {
  liveBrowser(slot).handle = handle;
  wakeAll();
  return () => {
    const browser = bySlot.get(slot);
    if (browser?.handle === handle) browser.handle = null;
    forgetIfUnused(slot);
  };
}

/** A tab registers itself while it is mounted, whether or not it is in front. */
export function registerPreviewTab(slot: string, tab: string, controller: PreviewController): () => void {
  liveBrowser(slot).tabs.set(tab, controller);
  wakeAll();
  return () => {
    const browser = bySlot.get(slot);
    if (browser?.tabs.get(tab) === controller) browser.tabs.delete(tab);
    forgetIfUnused(slot);
  };
}

/** The tab in front of a browser says so, and again whenever it comes on or off screen. */
export function setPreviewFront(slot: string, tab: string, visible: boolean): void {
  const browser = liveBrowser(slot);
  browser.front = tab;
  browser.visible = visible;
  wakeAll();
}

/** useChatViews tells which browser belongs to which chat. */
export function setPreviewSlots(slots: Record<string, string>): void {
  slotOfChat = slots;
  wakeAll();
}

/** The browser that belongs to `chat`, if it has one yet. */
export function previewSlotOf(chat: string): string | undefined {
  return slotOfChat[chat];
}

/** The browser of `chat`, or the one on screen for an agent that can't say which chat it runs
 *  in (Antigravity's MCP config is global). */
function browserFor(chat: string | undefined): LiveBrowser | null {
  if (chat) {
    const slot = slotOfChat[chat];
    return (slot && bySlot.get(slot)) || null;
  }
  for (const browser of bySlot.values()) {
    if (browser.visible && browser.front && browser.tabs.has(browser.front)) return browser;
  }
  return null;
}

/** The tab the agent's commands go to. A tab that closed or a stale id falls back to the front. */
function workingTab(browser: LiveBrowser, chat: string | undefined): string | null {
  if (chat && browser.pinned && browser.tabs.has(browser.pinned)) return browser.pinned;
  return browser.front && browser.tabs.has(browser.front) ? browser.front : null;
}

function controllerFor(chat: string | undefined): PreviewController | null {
  const browser = browserFor(chat);
  const tab = browser && workingTab(browser, chat);
  return (tab && browser?.tabs.get(tab)) || null;
}

function waitFor<T>(find: () => T | null, timeoutMs: number, error: string): Promise<T> {
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const wake = () => {
      const found = find();
      if (!found) return;
      clearTimeout(timer);
      waiters.delete(wake);
      resolve(found);
    };
    const timer = setTimeout(() => {
      waiters.delete(wake);
      reject(new Error(error));
    }, timeoutMs);
    waiters.add(wake);
  });
}

const NOT_OPEN = "The built-in browser didn't open. Is a project folder open in Nyxs?";

/** Whether the page the agent of `chat` would get is on screen right now. */
export function hasActivePreview(chat?: string): boolean {
  return controllerFor(chat)?.onScreen() ?? false;
}

/** A new turn of the chat: its agent works in the tab in front again, the one the user is looking
 *  at when they ask, until it opens another. */
export function startPreviewTurn(chat: string): void {
  const browser = browserFor(chat);
  if (browser) browser.pinned = null;
}

/** Shows the chat's browser (or starts it out of sight, for a chat in the background) and
 *  returns the tab its agent works in, once it is ready to take commands. */
export async function ensurePreview(chat?: string, timeoutMs = 5000): Promise<PreviewController> {
  window.dispatchEvent(new CustomEvent(OPEN_PREVIEW_EVENT, { detail: { chat } }));
  const page = await waitFor(() => controllerFor(chat), timeoutMs, NOT_OPEN);
  const browser = browserFor(chat);
  if (chat && browser) browser.pinned = workingTab(browser, chat);
  return page;
}

/** The project of the browser `chat` would get: the on-screen project can be another chat's. */
export function previewWorkspace(chat?: string): string | null {
  return browserFor(chat)?.handle?.workspace() ?? null;
}

function tabsOf(browser: LiveBrowser): BrowserTabInfo[] {
  return [...browser.tabs].map(([id, controller]) => ({
    id,
    page: controller.info(),
    front: id === browser.front,
    agent: browser.handle?.isAgentTab(id) ?? false,
  }));
}

/** The tabs of a browser, for choosing where an address opens. */
export function previewTabsOf(slot: string): BrowserTabInfo[] {
  const browser = bySlot.get(slot);
  return browser ? tabsOf(browser) : [];
}

/** The tab where the chat's agent should open `address` (see pickAgentTab), brought to the front
 *  unless the agent already works there: the user may have moved away from it on purpose. */
export async function previewForAddress(address: string, chat?: string, timeoutMs = 5000): Promise<PreviewController> {
  const current = await ensurePreview(chat, timeoutMs);
  const browser = browserFor(chat);
  const handle = browser?.handle;
  if (!browser || !handle) return current;
  const tabs = tabsOf(browser);
  const picked = pickAgentTab(address, tabs, handle.workspace(), browser.pinned);
  const tab = picked ?? handle.openAgentTab();
  if (tabs.find((t) => t.id === picked)?.page.kind === "empty") handle.claimTab(tab);
  if (tab !== workingTab(browser, chat)) handle.focusTab(tab);
  if (chat) browser.pinned = tab;
  return waitFor(() => browser.tabs.get(tab) ?? null, timeoutMs, NOT_OPEN);
}

/** Brings the agent's tab to the front of its browser, for what needs it drawn (a screenshot). */
export function showAgentTab(chat?: string): void {
  const browser = browserFor(chat);
  const tab = browser && workingTab(browser, chat);
  if (tab && browser.front !== tab) browser.handle?.focusTab(tab);
}
