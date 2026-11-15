import { useSyncExternalStore } from "react";

/** Whether the start-up splash (#nyxs-splash in index.html) is still on screen. Native webviews
 *  (the browser's websites) are drawn over the whole app, so they wait for it to be gone. */
let up = typeof document !== "undefined" && !!document.getElementById("nyxs-splash");
const listeners = new Set<() => void>();

export function splashGone(): void {
  if (!up) return;
  up = false;
  for (const l of [...listeners]) l();
}

export function useSplashUp(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => up,
  );
}
