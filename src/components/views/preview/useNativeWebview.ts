import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { localizedError } from "@/lib/i18n";
import { invoke } from "@/lib/ipc";
import {
  openPreviewWebview,
  setPreviewWebviewBounds,
  hidePreviewWebview,
  closePreviewWebview,
  type Bounds,
} from "@/lib/previewWebview";
import { setNativeViewShown } from "@/lib/nativeViews";
import { useSplashUp } from "@/lib/splash";
import { NATIVE_HOLES, decodeImage, nextPaint } from "./helpers";
import { useCoveredByApp, useWebviewHoles } from "./webviewHoles";

/** Where the tab's native webview goes (`contentBounds`), and whether it has to hide: behind
 *  the app's own menus and dialogs, in a background tab, under the start-up splash. */
export function useWebviewVisibility({
  tabId,
  active,
  extUrl,
  contentRef,
  rootRef,
  menuOpen,
  serversOpen,
  pickTipShown,
  barShown,
  setMenuOpen,
  setServersOpen,
}: {
  tabId: string;
  active: boolean;
  extUrl: string;
  contentRef: RefObject<HTMLDivElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  menuOpen: boolean;
  serversOpen: boolean;
  pickTipShown: boolean;
  barShown: boolean;
  setMenuOpen: (open: boolean) => void;
  setServersOpen: (open: boolean) => void;
}) {
  // A website stays on screen while the panel is resized: its bounds follow the drag (the
  // ResizeObserver below), and the mouse stays with the drag even over it.

  const contentBounds = useCallback((): Bounds | null => {
    const el = contentRef.current;
    const r = el?.getBoundingClientRect();
    if (!r) return null;
    // The native webview draws over the page, so it would cover the panel's resize handle:
    // leave that strip uncovered.
    const handle = el?.closest("aside")?.querySelector("[data-panel-resize]")?.getBoundingClientRect();
    const left = handle && handle.right > r.left && handle.left <= r.left ? handle.right : r.left;
    // Never past the window's edges: a panel wider than a shrunken window would otherwise put
    // a page bigger than the window on it.
    const right = Math.min(r.right, window.innerWidth);
    const bottom = Math.min(r.bottom, window.innerHeight);
    return { x: left, y: r.top, width: Math.max(0, right - left), height: Math.max(0, bottom - r.top) };
  }, [contentRef]);
  const { covered, dialog } = useCoveredByApp(contentRef, rootRef, contentBounds, active && !!extUrl);
  const holesActive = NATIVE_HOLES && (menuOpen || serversOpen || pickTipShown || barShown || dialog) && active && !!extUrl;
  useWebviewHoles(rootRef, tabId, contentBounds, holesActive, dialog);
  // A click on the page around a menu goes to the native webview, never to the app's
  // click-outside handlers; the app only sees its window lose focus.
  useEffect(() => {
    if (!holesActive) return;
    const close = () => { setMenuOpen(false); setServersOpen(false); };
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, [holesActive, setMenuOpen, setServersOpen]);
  const overlayOpen = (!NATIVE_HOLES && (menuOpen || serversOpen)) || covered;
  // After a reload the restored tab would show its website over the start-up splash.
  const splashUp = useSplashUp();
  const webviewHidden = overlayOpen || !active || splashUp;
  return { contentBounds, overlayOpen, webviewHidden };
}

/** Opens, moves, hides and closes the tab's native webview for `extUrl`. Returns the snapshot
 *  shown in its place while an overlay of the app hides it. */
export function useNativeWebview({
  tabId,
  active,
  extUrl,
  webviewHidden,
  overlayOpen,
  contentBounds,
  contentRef,
  profile,
  awaitingRestore,
  setExtError,
}: {
  tabId: string;
  active: boolean;
  extUrl: string;
  webviewHidden: boolean;
  overlayOpen: boolean;
  contentBounds: () => Bounds | null;
  contentRef: RefObject<HTMLDivElement | null>;
  profile: string;
  awaitingRestore: RefObject<boolean>;
  setExtError: (error: string) => void;
}) {
  const [frozen, setFrozen] = useState<{ url: string; src: string; left: number; width: number; height: number } | null>(null);
  const webviewShown = useRef(false);
  const webviewSeq = useRef(0);
  /** The address the tab's native webview was last opened at ("" while it has none). Opening
   *  one already open there (a page restored after a reload) changes nothing. */
  const openedUrl = useRef("");

  // Each tab owns its native webview; a tab in the background only hides it, so the page
  // stays loaded (scroll, forms, where the user browsed to) like in a real browser.
  useEffect(() => {
    const seq = ++webviewSeq.current;
    if (!extUrl) {
      if (awaitingRestore.current) return;
      webviewShown.current = false;
      openedUrl.current = "";
      setNativeViewShown(tabId, false);
      void closePreviewWebview(tabId);
      return;
    }
    if (webviewHidden) {
      const b = contentBounds();
      // A site opened while the tab is out of sight (the agent of a chat in the background, or
      // one behind a menu) loads hidden, at the panel's size or a common one while it has none.
      if (openedUrl.current !== extUrl && !awaitingRestore.current) {
        openedUrl.current = extUrl;
        const size = b && b.width >= 200 && b.height >= 200 ? b : { x: 0, y: 0, width: 1280, height: 800 };
        webviewShown.current = false;
        setNativeViewShown(tabId, false);
        void openPreviewWebview(tabId, extUrl, size, profile, true).catch((e) => setExtError(localizedError(e)));
        return;
      }
      const freeze = overlayOpen && active && webviewShown.current && b;
      void (async () => {
        if (freeze) {
          const png = await invoke<string>("preview_capture_png", { ...freeze, tab: tabId }).catch(() => null);
          const rect = contentRef.current?.getBoundingClientRect();
          if (seq !== webviewSeq.current) return;
          if (png && rect) {
            const src = `data:image/png;base64,${png}`;
            // Hiding the webview before the snapshot is on screen showed the empty panel for a
            // moment, a visible blink: decode it first and wait until it has been painted.
            await decodeImage(src);
            if (seq !== webviewSeq.current) return;
            setFrozen({ url: extUrl, src, left: freeze.x - rect.left, width: freeze.width, height: freeze.height });
            await nextPaint();
            if (seq !== webviewSeq.current) return;
          }
        }
        webviewShown.current = false;
        await hidePreviewWebview(tabId);
        setNativeViewShown(tabId, false);
      })();
      return;
    }
    const b = contentBounds();
    if (!b) return;
    openedUrl.current = extUrl;
    openPreviewWebview(tabId, extUrl, b, profile)
      .then(() => {
        webviewShown.current = true;
        setNativeViewShown(tabId, true);
        if (seq === webviewSeq.current) setFrozen(null);
      })
      .catch((e) => setExtError(localizedError(e)));
  }, [tabId, extUrl, webviewHidden, overlayOpen, active, contentBounds, profile, awaitingRestore, contentRef, setExtError]);

  useEffect(() => {
    if (!extUrl || webviewHidden) return;
    const el = contentRef.current;
    if (!el) return;
    let last: Bounds | null = null;
    const update = (onlyIfMoved = false) => {
      const b = contentBounds();
      if (!b) return;
      if (onlyIfMoved && last && b.x === last.x && b.y === last.y && b.width === last.width && b.height === last.height) return;
      last = b;
      setPreviewWebviewBounds(tabId, b);
    };
    const onResize = () => update();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    window.addEventListener("resize", onResize);
    // The observers only see the box change size. A box that only moves (a layout change that
    // shifts it, the window coming back from the computer-control corner) left the page where
    // it was, over the chat: check now and then that it's still in place.
    const check = window.setInterval(() => update(true), 400);
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); window.clearInterval(check); };
  }, [tabId, extUrl, webviewHidden, contentBounds, contentRef]);

  useEffect(() => () => { setNativeViewShown(tabId, false); void closePreviewWebview(tabId); }, [tabId]);

  return frozen;
}
