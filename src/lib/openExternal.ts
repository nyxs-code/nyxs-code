import { invoke } from "@/lib/ipc";
import { getBrowserPrefs } from "@/lib/browserPrefs";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function openExternalUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    void invoke("agent_open_external", { url }).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Fired with a URL for the app to show in the built-in browser. */
export const OPEN_IN_BROWSER_EVENT = "nyxs-open-in-browser";

/** Shows a site in the built-in browser, whatever the preference for the chat's links says. */
export function openInBuiltInBrowser(url: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_IN_BROWSER_EVENT, { detail: url }));
}

/** A link clicked in the chat: the built-in browser when that preference is on, else the system one. */
export function openChatLink(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri && getBrowserPrefs().openLinksInApp) {
    openInBuiltInBrowser(url);
    return;
  }
  openExternalUrl(url);
}

export function handleExternalLinkClick(e: { preventDefault: () => void; currentTarget: { href?: string } }): void {
  const href = e.currentTarget.href;
  if (!href) return;
  e.preventDefault();
  openExternalUrl(href);
}
