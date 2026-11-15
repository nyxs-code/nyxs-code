import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@/lib/ipc";
import type { Update } from "@tauri-apps/plugin-updater";

// One updater state for the whole window, shared by everyone who reads it, and kept current
// while the app stays open: it used to look for a new version only once, when the app
// started, so a release published during the day stayed invisible until the app was closed
// and opened again.

export type UpdaterStatus = "idle" | "available" | "downloading" | "ready" | "error";

export interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  notes: string | null;
  progress: number;
  /** A check is on the wire. Apart from `status`, so a poll that only confirms the version
   *  already on the card doesn't take the card down while it runs. */
  checking: boolean;
  /** The last check never got an answer (offline, GitHub having a bad minute), so an idle
   *  status can't be read as "this is the latest version". */
  checkFailed: boolean;
  /** The version whose card was waved away ("Not yet" means not this one): the next poll
   *  doesn't bring the same card back, but a newer version still shows. */
  dismissedKey: string | null;
}

/** How often the app looks for a new version while it is open. One small GET of the
 *  manifest; a download only ever starts when somebody presses the button. */
const CHECK_EVERY_MS = 30 * 60 * 1000;
/** Coming back to the window is a good moment to look, but alt-tabbing isn't worth a request
 *  each time: a burst of focus events collapses into one check. */
const FOCUS_THROTTLE_MS = 2 * 60 * 1000;

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const INITIAL: UpdaterState = { status: "idle", version: null, notes: null, progress: 0, checking: false, checkFailed: false, dismissedKey: null };

let state: UpdaterState = INITIAL;
const listeners = new Set<() => void>();
let pending: Update | null = null;
let inFlight: Promise<boolean> | null = null;

function patch(p: Partial<UpdaterState>) {
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Looks for a new version; answers whether one is available. */
function check(): Promise<boolean> {
  // Never mid-install: a poll landing then would overwrite the progress being watched.
  if (state.status === "downloading" || state.status === "ready") return Promise.resolve(true);
  if (inFlight) return inFlight;
  if (!isTauri) return Promise.resolve(false);
  const run = async (): Promise<boolean> => {
    try {
      const mod = await import("@tauri-apps/plugin-updater");
      const update = await mod.check();
      if (update) {
        pending = update;
        patch({ status: "available", version: update.version, notes: update.body ?? null, progress: 0, checkFailed: false });
        return true;
      }
      patch({ status: "idle", checkFailed: false });
      return false;
    } catch {
      // A failed check (offline, GitHub having a bad minute) leaves a found version as it was.
      if (state.status === "error") patch({ status: pending ? "available" : "idle" });
      patch({ checkFailed: true });
      return state.status === "available";
    }
  };
  patch({ checking: true });
  inFlight = run().finally(() => {
    inFlight = null;
    patch({ checking: false });
  });
  return inFlight;
}

async function install() {
  if (!pending || state.status === "downloading" || state.status === "ready") return;
  let stopped = false;
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    // On Windows the installer ends the app without its normal exit, where the window's
    // place is saved: saved here instead, so the app comes back on the same monitor.
    await invoke("save_window_state").catch(() => undefined);
    let total = 0;
    let downloaded = 0;
    patch({ status: "downloading", progress: 0 });
    await pending.download((e) => {
      if (e.event === "Started") {
        total = e.data.contentLength ?? 0;
      } else if (e.event === "Progress") {
        downloaded += e.data.chunkLength;
        patch({ progress: total ? Math.min(1, downloaded / total) : 0 });
      } else if (e.event === "Finished") {
        patch({ status: "ready", progress: 1 });
      }
    });
    // Only once the download is done, so work keeps running while it lasts: the processes the
    // app started (agent CLIs, MCP servers, other copies of Nyxs.exe) would keep the install
    // folder's files open and the Windows installer would fail with "the app is running".
    await invoke("nyxs_prepare_update").catch(() => undefined);
    stopped = true;
    await pending.install();
    await relaunch();
  } catch (e) {
    // The app stays open with its processes stopped: each starts again when next used (a new
    // Claude Code or CLI process per turn, MCP and language servers on their next request).
    // The app's log says so, for whoever looks into why the update didn't go through.
    if (stopped) void invoke("nyxs_update_install_failed", { error: String(e) }).catch(() => undefined);
    patch({ status: "error" });
  }
}

let readers = 0;
let stopPolling: (() => void) | null = null;

/** At start-up, on a timer, and whenever the window comes back. Started by the first reader
 *  and stopped with the last, so two readers never poll twice. */
function retainPolling(): () => void {
  readers += 1;
  if (readers === 1 && isTauri) {
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    let lastFocusCheck = Date.now();
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastFocusCheck < FOCUS_THROTTLE_MS) return;
      lastFocusCheck = now;
      void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    stopPolling = () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }
  return () => {
    readers -= 1;
    if (readers === 0) {
      stopPolling?.();
      stopPolling = null;
    }
  };
}

export function useUpdater() {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => retainPolling(), []);

  // A failed install has no new version to key on, so it is dismissed under its own name.
  const alertKey = s.version ?? "__no-version__";
  const visible = s.status !== "idle" && s.dismissedKey !== alertKey;

  return {
    ...s,
    visible,
    install,
    dismiss: () => patch({ dismissedKey: alertKey }),
    recheck: check,
  };
}

/** Test hook: the state, a way to set it, and a clean slate between cases. */
export const __updaterForTests = {
  get: () => state,
  patch,
  check,
  install,
  reset: () => {
    state = INITIAL;
    pending = null;
    inFlight = null;
  },
};
