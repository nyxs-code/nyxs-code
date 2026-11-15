import { invoke } from "@/lib/ipc";
import { getMergedSnapshot } from "@/lib/settingsRuntime";

const DEFAULT_BRANCH_PREFIX = "Nyxs";

function wtConfig(): { location?: string; branchPrefix?: string } {
  const wt = (getMergedSnapshot() as { worktree?: { location?: string; branchPrefix?: string } }).worktree ?? {};
  return {
    location: wt.location?.trim() ? wt.location.trim() : undefined,
    branchPrefix: wt.branchPrefix?.trim() || DEFAULT_BRANCH_PREFIX,
  };
}

export function worktreeCreate(workspace: string, id: string): Promise<string> {
  const { location, branchPrefix } = wtConfig();
  return invoke<string>("worktree_create", { workspace, id, location, branchPrefix });
}

/** A session's own worktree, on the branch `<prefix>/<session id>` (Desktop prepends the prefix
 *  to every worktree branch). Reopening the session gets the same one back. */
export async function createSessionWorktree(workspace: string, sessionId: string, existingBranch?: string): Promise<{ path: string; branch: string }> {
  const { location, branchPrefix } = wtConfig();
  // A session reopened keeps the branch it started on, whatever the prefix is now.
  const branch = existingBranch ?? `${(branchPrefix ?? DEFAULT_BRANCH_PREFIX).replace(/\/+$/, "")}/${sessionId}`;
  const path = await invoke<string>("session_worktree_create", { workspace, id: `session-${sessionId}`, branch, location });
  return { path, branch };
}

/** Takes a session's worktree away (its branch stays). Without `force`, uncommitted work blocks it. */
export function removeSessionWorktree(workspace: string, path: string, force = false): Promise<void> {
  return invoke("session_worktree_remove", { workspace, path, force });
}

export function worktreeRemove(workspace: string, id: string, force = false): Promise<void> {
  const { location, branchPrefix } = wtConfig();
  return invoke("worktree_remove", { workspace, id, force, location, branchPrefix });
}

export function worktreeExportPatch(workspace: string, id: string): Promise<string> {
  return invoke<string>("worktree_export_patch", { workspace, id, location: wtConfig().location });
}

export function worktreeApplyPatch(workspace: string, patch: string): Promise<void> {
  return invoke("worktree_apply_patch", { workspace, patch });
}

/** Rejects, with the reason, when the patch wouldn't go in cleanly; touches nothing either way. */
export function worktreeCheckPatch(workspace: string, patch: string): Promise<void> {
  return invoke("worktree_check_patch", { workspace, patch });
}

const mergeQueues = new Map<string, Promise<unknown>>();

/** Parallel agents finish at any time: each check-record-apply runs alone in its project, so no other
 *  merge lands between the check and the write. */
function oneMergeAtATime<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const next = (mergeQueues.get(workspace) ?? Promise.resolve()).then(fn, fn);
  mergeQueues.set(workspace, next.catch(() => undefined));
  return next;
}

export function worktreeSupported(workspace: string): Promise<boolean> {
  return invoke<boolean>("worktree_supported", { workspace }).catch(() => false);
}

export interface WithWorktreeOptions {
  onSuccess?: "apply" | "discard";
  forceRemove?: boolean;
  /** The files the patch will touch, called once it's known to apply and while the project still
   *  holds the old content (the changes view records its "before" here). */
  beforeApply?: (files: string[]) => void | Promise<void>;
  /** Called instead of throwing when the patch can't be merged back, so the run's result still bills. */
  onApplyError?: (error: unknown) => void;
}

/** The files a patch changes, from its `diff --git a/x b/x` headers (the `b` side is the new path). */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const rest = line.slice("diff --git ".length).trimEnd();
    let path = "";
    if (rest.startsWith('"')) {
      const m = /^"a\/(?:[^"\\]|\\.)*"\s+"b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
      if (m) path = m[1];
    } else {
      const at = rest.lastIndexOf(" b/");
      if (at > 0) path = rest.slice(at + 3);
    }
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export async function withWorktree<T>(
  workspace: string,
  id: string,
  fn: (worktreePath: string) => Promise<T>,
  options: WithWorktreeOptions = {},
): Promise<T> {
  const onSuccess = options.onSuccess ?? "apply";
  const forceRemove = options.forceRemove ?? true;
  const path = await worktreeCreate(workspace, id);
  try {
    const result = await fn(path);
    if (onSuccess === "apply") {
      const patch = await worktreeExportPatch(workspace, id);
      if (patch.trim()) {
        try {
          await oneMergeAtATime(workspace, async () => {
            // A patch that won't go in must not show up in the changes view as if it had.
            await worktreeCheckPatch(workspace, patch);
            await Promise.resolve(options.beforeApply?.(patchFiles(patch))).catch(() => undefined);
            await worktreeApplyPatch(workspace, patch);
          });
        } catch (e) {
          if (!options.onApplyError) throw e;
          options.onApplyError(e);
        }
      }
    }
    return result;
  } finally {
    try {
      await worktreeRemove(workspace, id, forceRemove);
    } catch {
      /* el worktree quedará para podar en el próximo arranque */
    }
  }
}
