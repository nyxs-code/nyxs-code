import { useSyncExternalStore } from "react";

/** The visual the chat moved to the side panel ("Show in another panel"), if any. */
export interface PanelVisual {
  id: string;
  src: string;
  title: string;
}

/** The same visual with the canvas's tools in the page (see CANVAS_SUFFIX in agent/mockup.rs). */
export function canvasSrc(src: string): string {
  return `${src}/canvas`;
}

let current: PanelVisual | null = null;
const listeners = new Set<() => void>();

export function setPanelVisual(next: PanelVisual | null): void {
  if (current?.id === next?.id && current?.src === next?.src) return;
  current = next;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function usePanelVisual(): PanelVisual | null {
  return useSyncExternalStore(subscribe, () => current);
}
