import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/ipc";
import type { Bounds } from "@/lib/previewWebview";
import { setNativeViewClear } from "@/lib/nativeViews";
import { NATIVE_HOLES } from "./helpers";

/** Whether something of the app's own (settings, a dialog, a menu) is drawn over the page
 *  area. The native webview always draws on top of the app, so it has to hide meanwhile.
 *  On Windows a dialog that marks its backdrop `data-webview-backdrop` and its panel
 *  `data-webview-hole` doesn't count: the page cuts a hole for the panel instead and keeps
 *  playing around it (`dialog`), where a snapshot would freeze a video. */
export function useCoveredByApp(
  ref: RefObject<HTMLElement | null>,
  root: RefObject<HTMLElement | null>,
  getBounds: () => Bounds | null,
  enabled: boolean,
): { covered: boolean; dialog: boolean } {
  const [covered, setCovered] = useState(false);
  const [dialog, setDialog] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const el = ref.current;
      const b = getBounds();
      if (!el || !b || b.width < 24 || b.height < 24) return;
      const overPage = (h: Element) => {
        const r = h.getBoundingClientRect();
        return r.right > b.x && r.left < b.x + b.width && r.bottom > b.y && r.top < b.y + b.height;
      };
      const holes = [...document.querySelectorAll("[data-webview-hole]")];
      // The tab's own menus that open with `menuOpen` get their holes without this; any other
      // one of its own (the bookmarks bar's) only needs one while it reaches over the page.
      setDialog(NATIVE_HOLES && holes.some((h) => !root.current?.contains(h) || overPage(h)));
      // Without holes a menu of the app over the page (the title bar's) has to hide the page,
      // and it can be too small to reach any of the points checked below.
      const overMenu = !NATIVE_HOLES && holes.some(overPage);
      const inset = 10;
      const right = b.x + b.width;
      const bottom = b.y + b.height;
      const points: [number, number][] = [
        [b.x + b.width / 2, b.y + b.height / 2],
        [b.x + inset, b.y + inset],
        [right - inset, b.y + inset],
        [b.x + inset, bottom - inset],
        [right - inset, bottom - inset],
      ];
      const hit = points.some(([x, y]) => {
        const top = document.elementFromPoint(x, y);
        return !!top && !el.contains(top) && !top.closest("[data-drag-shield],[data-webview-hole]") &&
          !(NATIVE_HOLES && top.hasAttribute("data-webview-backdrop")) && !isClickCatcher(top);
      });
      setCovered(hit || overMenu);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, root, getBounds, enabled]);
  return { covered: enabled && covered, dialog: enabled && dialog };
}

/** An invisible layer a menu spreads over the window to close itself on a click outside
 *  (`fixed inset-0`, nothing drawn). It hides nothing, so the page stays live under it instead
 *  of being swapped for a still snapshot; a click on the page blurs the window instead. */
export function isClickCatcher(el: Element): boolean {
  if (el.childElementCount > 0 || (el.textContent ?? "").trim()) return false;
  const s = getComputedStyle(el);
  const none = (v: string) => !v || v === "none";
  return backdropAlpha([s.backgroundColor]) === 0 && none(s.backgroundImage) && none(s.boxShadow) &&
    none(s.backdropFilter) && !Number.parseFloat(s.borderTopWidth);
}

interface Hole {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** The panel's `box-shadow`: it falls on the page, which draws it (preview_shadows.js). */
  shadow?: string;
}

/** How dark the open dialogs' backdrops make the app, stacked dialogs included. */
export function backdropAlpha(backgrounds: string[]): number {
  let clear = 1;
  for (const bg of backgrounds) {
    // rgba(0, 0, 0, 0.3), or the oklab(0 0 0 / 0.3) Tailwind's bg-black/30 computes to.
    const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(bg) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\)$/.exec(bg);
    const a = m ? Number(m[1]) / (m[2] ? 100 : 1) : /^(rgb|oklab|oklch|color)\(/.test(bg) ? 1 : 0;
    clear *= 1 - Math.min(1, Math.max(0, a));
  }
  return Math.round((1 - clear) * 1000) / 1000;
}

/** The backdrop a press lands on: the dialog in front (highest z-index, the last one opened
 *  when they tie). */
export function topBackdrop(backdrops: HTMLElement[]): HTMLElement | null {
  let top: HTMLElement | null = null;
  let topZ = -Infinity;
  for (const b of backdrops) {
    const z = Number.parseInt(getComputedStyle(b).zIndex, 10);
    const zi = Number.isFinite(z) ? z : 0;
    if (zi >= topZ) {
      top = b;
      topZ = zi;
    }
  }
  return top;
}

/** A press on the dimmed page around a dialog, given to the dialog's backdrop as if it had
 *  been pressed there, so each dialog does what its backdrop does (a dialog that can't be
 *  dismissed stays open). */
export function pressBackdrop(doc: Document = document): boolean {
  const target = topBackdrop([...doc.querySelectorAll<HTMLElement>("[data-webview-backdrop]")]);
  if (!target) return false;
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  return true;
}

/** While `enabled`, keeps a hole in the tab's page over every `[data-webview-hole]` element
 *  under `root` (a menu and its submenus), following them as they open, close and move.
 *  With `dialog`, the app's dialogs elsewhere get theirs too, the tab reports itself out of
 *  their way once the holes are cut, and the page is dimmed like the rest of the app (the
 *  backdrop is drawn under the native webview, so it can't reach the page). */
export function useWebviewHoles(root: RefObject<HTMLElement | null>, tabId: string, getBounds: () => Bounds | null, enabled: boolean, dialog: boolean) {
  useLayoutEffect(() => {
    const el = root.current;
    if (!enabled || !el) return;
    const scope = dialog ? document.body : el;
    let last = "";
    let dimmed = 0;
    let frame = 0;
    // A panel can change size with no attribute or child changing: its text updated in place
    // (a confirmation that learns of uncommitted files after it opened) or a font loading. A
    // centred dialog then grows both ways while its hole kept the old size.
    const watched = new Set<Element>();
    const ro = new ResizeObserver(() => schedule());
    const watch = (els: Element[]) => {
      const now = new Set(els);
      for (const e of watched) if (!now.has(e)) { ro.unobserve(e); watched.delete(e); }
      // Observing an element again would report it again and loop; only the new ones.
      for (const e of now) if (!watched.has(e)) { ro.observe(e); watched.add(e); }
    };
    const dim = () => {
      const alpha = backdropAlpha(
        [...document.querySelectorAll<HTMLElement>("[data-webview-backdrop]")].map((b) => getComputedStyle(b).backgroundColor),
      );
      if (alpha === dimmed) return;
      dimmed = alpha;
      void invoke("preview_set_dim", { tab: tabId, alpha }).catch(() => undefined);
    };
    const send = () => {
      frame = 0;
      const b = getBounds();
      if (!b) return;
      const els = [...scope.querySelectorAll<HTMLElement>("[data-webview-hole]")];
      watch(els);
      const holes: Hole[] = els
        .map((h) => {
          const r = h.getBoundingClientRect();
          const style = getComputedStyle(h);
          const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
          const shadow = style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : undefined;
          return { x: r.left - b.x, y: r.top - b.y, width: r.width, height: r.height, radius, shadow };
        })
        .filter((h) => h.x < b.width && h.y < b.height && h.x + h.width > 0 && h.y + h.height > 0);
      const key = JSON.stringify(holes);
      if (key === last) {
        if (dialog && dimmed) dim();
        return;
      }
      last = key;
      void invoke<boolean>("preview_set_holes", { tab: tabId, holes, pageWidth: b.width })
        .then((cut) => {
          if (!cut || !dialog) return;
          setNativeViewClear(tabId, true);
          dim();
        })
        .catch(() => undefined);
    };
    send();
    const schedule = () => { if (!frame) frame = requestAnimationFrame(send); };
    const mo = new MutationObserver(schedule);
    mo.observe(scope, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", schedule);
    return () => {
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      setNativeViewClear(tabId, false);
      void invoke("preview_set_holes", { tab: tabId, holes: [] }).catch(() => undefined);
      if (dimmed) void invoke("preview_set_dim", { tab: tabId, alpha: 0 }).catch(() => undefined);
    };
  }, [root, tabId, getBounds, enabled, dialog]);

  // The page covers the dialog's backdrop around the panel; its dim layer reports a press
  // there instead (preview-backdrop).
  useEffect(() => {
    if (!enabled || !dialog) return;
    const unlisten = listen<string>("preview-backdrop", ({ payload }) => {
      if (payload === tabId) pressBackdrop();
    });
    return () => { void unlisten.then((f) => f()); };
  }, [tabId, enabled, dialog]);
}
