import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { replayPageKey, toPageKey } from "@/lib/pageShortcuts";

/** The app's shortcuts typed with the focus in the tab's page: the page's bridge passes them on
 *  (a local page by postMessage, a website through Rust, which checks the key was really
 *  pressed) and the app does them as if typed in it. */
export function usePageShortcuts(tabId: string, iframeRef: RefObject<HTMLIFrameElement | null>) {
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { source?: string } | null;
      if (d?.source !== "nyxs-agent-key" || e.source !== iframeRef.current?.contentWindow) return;
      const key = toPageKey(d);
      if (key) replayPageKey(key);
    };
    window.addEventListener("message", onMsg);
    const unlisten = listen<{ tab: string; key: unknown }>("preview-key", (ev) => {
      if (ev.payload.tab !== tabId) return;
      const key = toPageKey(ev.payload.key);
      if (key) replayPageKey(key);
    });
    return () => {
      window.removeEventListener("message", onMsg);
      void unlisten.then((f) => f());
    };
  }, [tabId, iframeRef]);
}
