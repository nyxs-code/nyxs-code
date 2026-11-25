import { useSyncExternalStore } from "react";
import type { SideCorner } from "@/lib/sideChat";

/** The panels that can be minimized to a card in a corner of the chat (Claude's "Open minimized"). */
export type MinimizableView = "preview" | "terminal";

interface State {
  views: MinimizableView[];
  corner: SideCorner;
}

const CORNER_KEY = "nyxs.minimizedViews.corner.v1";
const listeners = new Set<() => void>();

function loadCorner(): SideCorner {
  try {
    const c = localStorage.getItem(CORNER_KEY);
    if (c === "top-left" || c === "top-right" || c === "bottom-left" || c === "bottom-right") return c;
  } catch {
    // Storage unavailable.
  }
  // The side chat's card starts bottom-right; this one keeps out of its way.
  return "bottom-left";
}

let state: State = { views: [], corner: loadCorner() };

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function minimizeView(view: MinimizableView): void {
  if (!state.views.includes(view)) set({ views: [...state.views, view] });
}

/** The panel is open again (from its card or its title-bar button): its card goes. */
export function forgetMinimized(view: MinimizableView): void {
  if (state.views.includes(view)) set({ views: state.views.filter((v) => v !== view) });
}

export function setMinimizedCorner(corner: SideCorner): void {
  try {
    localStorage.setItem(CORNER_KEY, corner);
  } catch {
    // Storage unavailable: kept until the app closes.
  }
  set({ corner });
}

export function useMinimizedViews(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** The corner an arrow key moves a card to: up and down change the row, left and right the side. */
export function cornerAfterKey(corner: SideCorner, key: string): SideCorner | null {
  const [row, side] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  if (key === "ArrowUp") return `top-${side}`;
  if (key === "ArrowDown") return `bottom-${side}`;
  if (key === "ArrowLeft") return `${row}-left`;
  if (key === "ArrowRight") return `${row}-right`;
  return null;
}
