import { useEffect, useSyncExternalStore } from "react";
import { onRuntimeProgress, runtimeInstall, runtimeStatus, type RuntimeProgress } from "@/lib/video/videoApi";

export type Stage = "copying" | "installing" | "browser";
export const STAGES: Stage[] = ["copying", "installing", "browser"];
/** Share of the bar each stage takes; npm install is most of the wait. */
const SPAN: Record<Stage, [number, number]> = { copying: [0, 0.08], installing: [0.08, 0.8], browser: [0.8, 1] };

export interface RuntimeState {
  phase: "checking" | "installing" | "ready" | "error";
  stage: Stage | null;
  progress: number;
  line: string | null;
  error: string | null;
}

let state: RuntimeState = { phase: "checking", stage: null, progress: 0, line: null, error: null };
let started = false;
const listeners = new Set<() => void>();

function set(p: Partial<RuntimeState>) {
  state = { ...state, ...p };
  for (const l of [...listeners]) l();
}

function onProgress(p: RuntimeProgress) {
  if (p.stage === "done" || p.stage === "error") return;
  // The player's pre-build is the short tail of the last step, not a step of its own.
  const stage = p.stage === "player" ? "browser" : p.stage;
  const [a, b] = SPAN[stage];
  const within = typeof p.progress === "number" ? Math.min(1, Math.max(0, p.progress)) : 0;
  set({ stage, progress: Math.max(state.progress, a + (b - a) * within), line: p.line ?? state.line });
}

/** Checks the shared video runtime and installs it the first time (once per app run; the
 *  backend makes concurrent installs, e.g. from an agent tool, share one). */
async function ensure() {
  if (started) return;
  started = true;
  set({ phase: "checking", error: null });
  try {
    const status = await runtimeStatus();
    if (status.installed) {
      set({ phase: "ready", progress: 1 });
      return;
    }
    set({ phase: "installing", stage: "copying", progress: 0, line: null });
    const unlisten = await onRuntimeProgress(onProgress).catch(() => null);
    try {
      await runtimeInstall();
    } finally {
      unlisten?.();
    }
    set({ phase: "ready", progress: 1 });
  } catch (e) {
    started = false;
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export function retryRuntime() {
  started = false;
  void ensure();
}

/** The runtime's state; starts the check (and install) on first use. */
export function useVideoRuntime(enabled: boolean): RuntimeState {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
  useEffect(() => {
    if (enabled) void ensure();
  }, [enabled]);
  return s;
}
