import { useEffect } from "react";

/** Keyboard access to the composer's menus (Ctrl+Shift+M / I / E, like Claude Code Desktop):
 *  the app's shortcuts fire these events and the menus answer them. */
export type ComposerMenu = "mode" | "model";
const OPEN_EVENT = "nyxs:open-composer-menu";
const EFFORT_EVENT = "nyxs:cycle-effort";

export const openComposerMenu = (menu: ComposerMenu) =>
  window.dispatchEvent(new CustomEvent<ComposerMenu>(OPEN_EVENT, { detail: menu }));
export const cycleComposerEffort = () => window.dispatchEvent(new Event(EFFORT_EVENT));

/** Runs `open` when the shortcut asks for `menu`, if this menu's button is on screen (a hidden
 *  composer, like one in a closed panel, stays shut). */
export function useOpenComposerMenu(menu: ComposerMenu, anchor: React.RefObject<HTMLElement | null>, open: () => void) {
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<ComposerMenu>).detail !== menu) return;
      if (!anchor.current?.offsetParent) return;
      open();
    };
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, [menu, anchor, open]);
}

export function useCycleEffort(anchor: React.RefObject<HTMLElement | null>, cycle: () => void) {
  useEffect(() => {
    const on = () => {
      if (anchor.current?.offsetParent) cycle();
    };
    window.addEventListener(EFFORT_EVENT, on);
    return () => window.removeEventListener(EFFORT_EVENT, on);
  }, [anchor, cycle]);
}

/** While a menu is open, 1–9 pick its items (the numbers it shows beside them) and Escape
 *  closes it. Typing in a field of the menu (the model search) keeps its digits. */
export function useMenuKeys(open: boolean, pick: (index: number) => void, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (!/^[1-9]$/.test(e.key)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || t.closest("input, textarea, select"))) {
        // The composer keeps focus while the menu is open: digits pick, they aren't typed.
        if (!t.closest("[data-composer]") || t.closest("[data-composer-menu]")) return;
      }
      e.preventDefault();
      e.stopPropagation();
      pick(Number(e.key) - 1);
    };
    // Capture: the composer's own Enter/arrow handling must not see the digit first.
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [open, pick, close]);
}
