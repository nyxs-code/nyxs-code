import { invoke } from "@/lib/ipc";
import { resolvePath } from "@/tools/paths";
import { fileActivity, normActivityPath, type FileActivityLog } from "./fileActivity";
import { fileHistoryRecordLeftAs, type FileHistoryState, type LeftAs, type UpdateFileHistory } from "./fileHistory";
import type { ShellChange } from "./shellChanges";
import type { ToolDetail } from "./toolDetail";

/** Tools whose end means a file they named was just written. Codex's and the ACP CLIs' edits
 *  show up as `Edit` too. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface AgentWritesDeps {
  log: FileActivityLog;
  /** The file's `agent_fh_hash`. */
  hash: (path: string) => Promise<string>;
  now: () => number;
}

export interface AgentWrites {
  /** The agent is about to write `path` (`onFileEdit`, absolute). */
  willWrite: (path: string) => void;
  /** A tool call's detail: once an edit tool has ended, the files it wrote get their hash. */
  tool: (detail: ToolDetail) => void;
  /** One of the agent's commands changed files: those the session tracks get a hash too, or are
   *  contested when the command was (`ShellChange.contested`). */
  shell: (change: ShellChange) => void;
  /** The turn is over. A file nobody else touched since its last hash gets a fresh one, so a
   *  write no tool event named (a notebook edited twice) still counts as the agent's. */
  finish: () => Promise<void>;
}

const defaultHash = (path: string) => invoke<string>("agent_fh_hash", { path });

/** Notes, for "Revertir", how the agent left each file it wrote in turn `messageId` (`leftAs`):
 *  the hash right after its last write, or contested when another session or the user wrote the
 *  file in the same stretch. A rewind then restores a file only if it still holds that hash. */
export function trackAgentWrites(
  chatId: string,
  workspace: string,
  messageId: string,
  update: UpdateFileHistory,
  deps: Partial<AgentWritesDeps> = {},
): AgentWrites {
  const { log = fileActivity, hash = defaultHash, now = Date.now } = deps;
  // By normalized path: the path as the agent gave it, when this turn first wrote it, and when
  // its last hash was taken.
  const files = new Map<string, { path: string; since: number; hashedAt?: number }>();
  // Announced by onFileEdit and not hashed since.
  const pending = new Set<string>();
  // One chain per file, so an older hash never lands after a newer one.
  const chains = new Map<string, Promise<void>>();

  const entry = (path: string, since = now()) => {
    const key = normActivityPath(path);
    if (!files.has(key)) files.set(key, { path, since });
    return key;
  };
  const settle = (key: string, contested = false) => {
    const f = files.get(key);
    if (!f) return;
    const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
      const at = now();
      // Only writers that name the file: a command elsewhere whose files are unknown would
      // otherwise contest every edit made while it runs. Those are caught by the hash anyway
      // when they write after this.
      const clash = contested || log.contested(chatId, [f.path], f.since, at, { namedOnly: true }).length > 0;
      const left: LeftAs = clash ? { contested: true } : { hash: await hash(f.path).catch(() => "unreadable") };
      f.hashedAt = at;
      fileHistoryRecordLeftAs(update, messageId, f.path, left);
    });
    chains.set(key, next.catch(() => {}));
  };
  const tracked = (path: string) => {
    let state: FileHistoryState | undefined;
    update((s) => {
      state = s;
      return s;
    });
    const key = normActivityPath(path);
    return [...(state?.trackedFiles ?? [])].some((p) => normActivityPath(p) === key);
  };
  // An edit tool's detail names its file (apply_patch: several, comma-separated). Only files
  // this turn announced count, so a name read wrong never hashes another file.
  const namedBy = (detail: ToolDetail) =>
    [detail.detail, ...detail.detail.split(", ")]
      .filter(Boolean)
      .flatMap((p) => {
        try {
          return [normActivityPath(resolvePath(p, workspace))];
        } catch {
          // Outside the project: not a file this turn wrote.
          return [];
        }
      })
      .filter((k) => files.has(k));

  return {
    willWrite: (path) => {
      pending.add(entry(path));
    },
    tool: (detail) => {
      if (!detail.endedAt || !EDIT_TOOLS.has(detail.name)) return;
      const keys = new Set([...pending, ...namedBy(detail)]);
      pending.clear();
      for (const key of keys) settle(key);
    },
    shell: (change) => {
      const root = workspace.replace(/[\\/]+$/, "");
      for (const file of change.files) {
        const path = `${root}/${file}`;
        const known = files.has(normActivityPath(path));
        if (!known && !tracked(path)) continue;
        settle(entry(path, change.startedAt), change.contested?.includes(file));
      }
    },
    finish: async () => {
      await Promise.all(chains.values());
      const at = now();
      for (const [key, f] of files) {
        const busy = log.contested(chatId, [f.path], f.hashedAt ?? f.since, at).length > 0;
        if (!busy) settle(key);
        // Never hashed, and someone may have written it meanwhile: its state can't be told apart.
        else if (f.hashedAt === undefined) settle(key, true);
      }
      await Promise.all(chains.values());
    },
  };
}
