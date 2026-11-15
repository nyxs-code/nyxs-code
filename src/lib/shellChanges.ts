import { invoke } from "@/lib/ipc";
import { listen } from "@tauri-apps/api/event";
import type { ToolSet } from "ai";
import { isAutoApprovableReadOnly } from "./bashSafety";

export interface ShellChange {
  before: string;
  after: string;
  files: string[];
  /** When the snapshot before the command was taken and when the one after it was, in ms.
   *  Missing in changes saved before 2026-10-31. */
  startedAt?: number;
  endedAt?: number;
  /** Of `files`, those someone else may have written while the command ran (another session,
   *  the user in Nyxs' editor): the snapshots can't tell their change from the command's, so a
   *  rewind leaves them as they are. */
  contested?: string[];
}

export type ShadowSnapshot = (workspace: string) => Promise<string | undefined>;
/** The files that differ between two trees; undefined when that can't be told (a tree lost from
 *  the snapshots repository), which is not the same as "none". */
export type ShadowDiff = (workspace: string, from: string, to: string) => Promise<string[] | undefined>;
export type ShellStatus = (shellId: string) => Promise<string | undefined>;
export type OnShellExit = (handler: (shellId: string, status?: string) => void) => Promise<() => void>;

export const shadowSnapshot: ShadowSnapshot = async (workspace) => {
  try {
    const tree = await invoke<string>("agent_shadow_snapshot", { workspace });
    return tree || undefined;
  } catch {
    return undefined;
  }
};

export const shadowDiff: ShadowDiff = async (workspace, from, to) => {
  try {
    return await invoke<string[]>("agent_shadow_changed", { workspace, from, to });
  } catch {
    return undefined;
  }
};

export const shellStatus: ShellStatus = async (shellId) => {
  try {
    // An offset past the end returns no output, only the status.
    const res = await invoke<{ status: string }>("agent_bg_output", { id: shellId, after: Number.MAX_SAFE_INTEGER, waitMs: 0 });
    return res.status;
  } catch {
    return undefined;
  }
};

export const onShellExit: OnShellExit = (handler) =>
  listen<{ id: string; status?: string }>("bg-shell-exit", (e) => handler(e.payload.id, e.payload.status));

/** How long after its turn a background command may still exit and have its changes kept. */
export const LATE_EXIT_WINDOW_MS = 15 * 60_000;

export interface ShellTrackerDeps {
  snapshot: ShadowSnapshot;
  diff: ShadowDiff;
  status: ShellStatus;
  onExit: OnShellExit;
  lateExitWindowMs: number;
  now: () => number;
}

export interface ShellChangeTracker {
  finish: () => Promise<void>;
}

const SHELL_ID_RE = /^Shell ID: (\S+)$/m;
const hasEnded = (status: string | undefined) => status !== undefined && status !== "running";

export function trackShellChanges(
  tools: ToolSet,
  workspace: string,
  record: (change: ShellChange) => void,
  deps: Partial<ShellTrackerDeps> = {},
): ShellChangeTracker {
  const {
    snapshot = shadowSnapshot,
    diff = shadowDiff,
    status = shellStatus,
    onExit = onShellExit,
    lateExitWindowMs = LATE_EXIT_WINDOW_MS,
    now = Date.now,
  } = deps;
  // Background shell id -> tree taken right before it was launched, and when.
  const background = new Map<string, { tree: string; startedAt: number }>();
  // Background commands still running when the turn ended.
  const late = new Set<string>();
  let lateTimer: ReturnType<typeof setTimeout> | undefined;
  const settling = new Set<Promise<void>>();
  let unlisten: Promise<() => void> | undefined;

  const stopListening = async () => {
    const stop = unlisten;
    unlisten = undefined;
    (await stop)?.();
  };
  const settle = async (before: string, startedAt: number) => {
    const after = await snapshot(workspace);
    const endedAt = now();
    if (!after || after === before) return;
    const files = await diff(workspace, before, after);
    if (files?.length) record({ before, after, files, startedAt, endedAt });
  };
  // A background command's window closes when its process exits, so edits
  // other people make later in the turn aren't blamed on it.
  const exited = (shellId: string, exitStatus?: string) => {
    const launch = background.get(shellId);
    if (launch === undefined) return;
    background.delete(shellId);
    if (late.delete(shellId)) {
      if (!late.size) {
        clearTimeout(lateTimer);
        void stopListening();
      }
      // Stopped by hand after its turn: a dev server or a watcher, whose
      // window spans whatever the user edited while it ran.
      if (exitStatus === "killed") return;
    }
    const p: Promise<void> = settle(launch.tree, launch.startedAt)
      .catch(() => {})
      .finally(() => settling.delete(p));
    settling.add(p);
  };

  const bash = tools.Bash;
  const run = bash?.execute;
  if (bash && run) {
    tools.Bash = {
      ...bash,
      execute: async (input: unknown, options: Parameters<typeof run>[1]) => {
        const { command, run_in_background } = (input ?? {}) as { command?: unknown; run_in_background?: unknown };
        if (typeof command !== "string" || isAutoApprovableReadOnly(command)) return run(input, options);
        // Taken before the snapshot: a change made while it is being taken may or may not be in it.
        const startedAt = now();
        const before = await snapshot(workspace);
        if (before && run_in_background === true) {
          unlisten ??= onExit(exited).catch(() => () => {});
          await unlisten;
        }
        const result = await run(input, options);
        if (!before) return result;
        if (run_in_background !== true) {
          await settle(before, startedAt);
          return result;
        }
        const shellId = typeof result === "string" ? SHELL_ID_RE.exec(result)?.[1] : undefined;
        if (shellId) {
          background.set(shellId, { tree: before, startedAt });
          // It may have exited before we started watching for its id.
          if (hasEnded(await status(shellId))) exited(shellId);
        }
        return result;
      },
    };
  }
  return {
    finish: async () => {
      for (const shellId of [...background.keys()]) {
        if (hasEnded(await status(shellId))) exited(shellId);
      }
      // Still running: a build or an install that ends on its own a little
      // later is still attributed to this turn when it exits. Past the window,
      // or once stopped by hand, it's a server or a watcher whose interval
      // covers too much of other people's work, so it records nothing.
      for (const shellId of background.keys()) late.add(shellId);
      await Promise.all([...settling]);
      clearTimeout(lateTimer);
      if (!late.size) return stopListening();
      lateTimer = setTimeout(() => {
        for (const shellId of late) background.delete(shellId);
        late.clear();
        void stopListening();
      }, lateExitWindowMs);
    },
  };
}
