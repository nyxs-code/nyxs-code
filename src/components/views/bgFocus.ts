import { useSyncExternalStore } from "react";

export interface BackgroundFocus {
  id: string;
  title: string;
  nonce: number;
}

let current: BackgroundFocus | null = null;
const listeners = new Set<() => void>();

export function focusBackgroundTask(id: string, title: string): void {
  current = { id, title, nonce: (current?.nonce ?? 0) + 1 };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

export function useBackgroundFocus(): BackgroundFocus | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function focusMatches(focus: BackgroundFocus | null, id: string, title: string): focus is BackgroundFocus {
  return !!focus && focus.id === id && focus.title === title;
}
