import { useSyncExternalStore } from "react";

/** Preferences of the built-in browser (the preview panel), kept on this machine. */
export type Viewport = "responsive" | "mobile" | "tablet" | "desktop";
export type CookieMode = "shared" | "project" | "private";

export interface BrowserPrefs {
  /** Links clicked in the chat open in the built-in browser instead of the system one. */
  openLinksInApp: boolean;
  viewport: Viewport;
  cookies: CookieMode;
}

export const VIEWPORT_SIZES: Record<Exclude<Viewport, "responsive">, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

const KEY = "nyxs.browserPrefs";
const DEFAULTS: BrowserPrefs = { openLinksInApp: true, viewport: "responsive", cookies: "shared" };

function read(): BrowserPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<BrowserPrefs>;
    return {
      openLinksInApp: typeof p.openLinksInApp === "boolean" ? p.openLinksInApp : DEFAULTS.openLinksInApp,
      viewport: p.viewport && (p.viewport === "responsive" || p.viewport in VIEWPORT_SIZES) ? p.viewport : DEFAULTS.viewport,
      cookies: p.cookies === "project" || p.cookies === "private" ? p.cookies : DEFAULTS.cookies,
    };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getBrowserPrefs(): BrowserPrefs {
  return current;
}

export function setBrowserPrefs(patch: Partial<BrowserPrefs>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* still applies for this run */ }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useBrowserPrefs(): BrowserPrefs {
  return useSyncExternalStore(subscribe, getBrowserPrefs, getBrowserPrefs);
}

/** The cookie profile the native webview uses: shared, one per project, or nothing kept. */
export function cookieProfile(mode: CookieMode, workspace: string | null): string {
  if (mode === "private") return "private";
  if (mode === "shared" || !workspace) return "shared";
  let h = 0x811c9dc5;
  for (const ch of workspace.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `p-${h.toString(16)}`;
}
