// State that has to outlive a reload of the app's page (Ctrl+R, "Refresh"). Work that runs in
// the native side (terminals, dev servers, browser pages, Claude Code processes) keeps going
// while the page reloads; what the page needs to find it again is kept in sessionStorage,
// which survives a reload but not closing the app.

const PREFIX = "nyxs.reload.";

export function loadReloadState<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveReloadState(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable: the next reload just starts fresh */
  }
}

/** Every saved key that starts with `prefix`, with its value. */
export function reloadStateEntries<T>(prefix: string): [string, T][] {
  const out: [string, T][] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(PREFIX + prefix)) continue;
      const value = loadReloadState<T>(key.slice(PREFIX.length));
      if (value !== null) out.push([key.slice(PREFIX.length), value]);
    }
  } catch {
    /* nothing to restore */
  }
  return out;
}
