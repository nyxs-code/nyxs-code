import { useSyncExternalStore } from "react";

// The sidebar rows the user moved to More (like Claude's "Hide {row}"), kept per device.
const KEY = "nyxs.sidebar.hiddenRows.v1";
const listeners = new Set<() => void>();
let cached: string[] | null = null;

function read(): string[] {
  if (cached) return cached;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    cached = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    cached = [];
  }
  return cached;
}

/** Moves a row to the More menu (hidden) or back to the sidebar. */
export function setSidebarRowHidden(id: string, hidden: boolean): void {
  const now = read();
  const next = hidden ? (now.includes(id) ? now : [...now, id]) : now.filter((x) => x !== id);
  if (next === now) return;
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or off: it lasts until the app closes.
  }
  listeners.forEach((l) => l());
}

/** The rows in the More menu now. */
export function useHiddenSidebarRows(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    read,
  );
}

/** For tests: forget what was read, so the next read comes from storage. */
export function resetSidebarRowsCache(): void {
  cached = null;
}
