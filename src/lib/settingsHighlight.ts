const EVENT = "nyxs:setting-highlight";
let pending: string | null = null;

export function requestSettingHighlight(key: string): void {
  pending = key;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
  }
}

export function consumePendingHighlight(key: string): boolean {
  if (pending === key) {
    pending = null;
    return true;
  }
  return false;
}

export function onSettingHighlight(key: string, cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    if ((e as CustomEvent).detail === key) cb();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
