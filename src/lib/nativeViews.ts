import { useEffect, useState } from "react";

/** Which browser tabs show a native webview right now. A native webview is drawn over the whole
 *  app, so a dialog opened over it would show behind it until the tab notices and hides it. */
const shown = new Set<string>();
/** Tabs whose webview has cut holes where the app's dialogs are, so it stays on screen around them. */
const clear = new Set<string>();
const listeners = new Set<() => void>();

function toggle(set: Set<string>, tab: string, on: boolean): void {
  if (on === set.has(tab)) return;
  if (on) set.add(tab);
  else set.delete(tab);
  for (const l of [...listeners]) l();
}

export function setNativeViewShown(tab: string, on: boolean): void {
  toggle(shown, tab, on);
}

export function setNativeViewClear(tab: string, on: boolean): void {
  toggle(clear, tab, on);
}

const inTheWay = () => [...shown].some((tab) => !clear.has(tab));

/** Resolves once no native webview is drawn over the app's dialogs, or after `timeoutMs` at most. */
export function whenNativeViewsHidden(timeoutMs: number): Promise<void> {
  if (!inTheWay()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { listeners.delete(check); window.clearTimeout(timer); resolve(); };
    const check = () => { if (!inTheWay()) done(); };
    const timer = window.setTimeout(done, timeoutMs);
    listeners.add(check);
  });
}

/** For a dialog: false while a website is still on screen above it. The dialog renders but stays
 *  invisible meanwhile (the browser sees it covering the page and cuts a hole for it, or
 *  snapshots the page and hides itself), then appears at once, already in front. */
export function useShownOverNativeViews(open: boolean): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void whenNativeViewsHidden(600).then(() => { if (alive) setReady(true); });
    return () => { alive = false; setReady(false); };
  }, [open]);
  return open && ready;
}
