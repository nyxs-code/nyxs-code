/**
 * The last value read of something slow to read (a CLI's status, its accounts, its plan usage),
 * kept in memory and in localStorage so the settings show it at once, even right after a
 * restart, while a fresh reading is taken quietly: zeron's stale-while-revalidate. A reading
 * that fails keeps the last good one.
 */
export interface Cached<T> {
  at: number;
  value: T;
}

export function persistedCache<T>(storageKey: string) {
  let entries: Record<string, Cached<T>> | null = null;
  const all = (): Record<string, Cached<T>> => {
    if (!entries) {
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}") as unknown;
        entries = parsed && typeof parsed === "object" ? (parsed as Record<string, Cached<T>>) : {};
      } catch {
        entries = {};
      }
    }
    return entries;
  };
  return {
    get(key: string): Cached<T> | undefined {
      return all()[key];
    },
    set(key: string, value: T) {
      all()[key] = { at: Date.now(), value };
      try {
        localStorage.setItem(storageKey, JSON.stringify(entries));
      } catch {
        /* storage full: the memory copy still serves this run */
      }
    },
  };
}
