import { isAutoApprovableReadOnly } from "./bashSafety";
import type { ShellChange } from "./shellChanges";
import type { ToolDetail } from "./toolDetail";

/** Who may have been writing which files, and when: each session's turn (native agents and CLIs
 *  alike), the user saving in Nyxs' editor, and rewinds. Shadow snapshots taken around an agent's
 *  command can't say who made a change; this tells "Revertir" when someone else was writing the
 *  same files at the same time. It lives in memory: the verdict is taken when the command ends and
 *  saved with its change (`ShellChange.contested`). */
export interface FileActivityLog {
  /** `owner` is about to change `path`, and may go on changing it until its turn ends. */
  editing: (owner: string, path: string) => void;
  /** `owner` wrote `path` once, just now (a save in the editor). */
  wrote: (owner: string, path: string) => void;
  /** `owner` started something that may write files nobody can name (a shell command, a
   *  subagent). Open until `close` with the same key or the end of its turn. */
  open: (owner: string, key: string) => void;
  close: (owner: string, key: string) => void;
  /** Closes everything `owner` left open: its turn is over. */
  end: (owner: string) => void;
  /** Of `files` (absolute paths), the ones someone other than `owner` may have written between
   *  `from` and `to`. With `namedOnly`, only writers that named the file count, not a command or
   *  subagent whose files are unknown. */
  contested: (owner: string, files: string[], from: number, to: number, opts?: { namedOnly?: boolean }) => string[];
}

interface Span {
  owner: string;
  /** Normalized path; null when the writer's files are unknown. */
  path: string | null;
  key: string;
  from: number;
  to: number | null;
}

/** Tool events and snapshots are a moment off the real write: a tool's start shows up just
 *  before it writes, a CLI's result just after. Widening every span by this errs on the side of
 *  keeping a file. */
export const ACTIVITY_SLACK_MS = 2_000;
/** Spans that ended longer ago than this can't overlap a command still to be judged: one that
 *  outlives its turn is only followed for 15 minutes. */
const RETAIN_MS = 3 * 60 * 60_000;

/** Windows and macOS paths ignore case; on Linux this may merge two names, which only makes a
 *  file look contested, never the other way round. */
export const normActivityPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();

export function createFileActivityLog(now: () => number = Date.now): FileActivityLog {
  let spans: Span[] = [];
  const prune = () => {
    const cutoff = now() - RETAIN_MS;
    spans = spans.filter((s) => s.to === null || s.to >= cutoff);
  };
  const openSpan = (owner: string, path: string | null, key: string) => {
    if (spans.some((s) => s.owner === owner && s.key === key && s.to === null)) return;
    prune();
    spans.push({ owner, path, key, from: now(), to: null });
  };
  return {
    editing: (owner, path) => {
      const p = normActivityPath(path);
      openSpan(owner, p, `edit:${p}`);
    },
    wrote: (owner, path) => {
      prune();
      const at = now();
      spans.push({ owner, path: normActivityPath(path), key: "write", from: at, to: at });
    },
    open: (owner, key) => openSpan(owner, null, `run:${key}`),
    close: (owner, key) => {
      const at = now();
      for (const s of spans) if (s.owner === owner && s.key === `run:${key}` && s.to === null) s.to = at;
    },
    end: (owner) => {
      const at = now();
      for (const s of spans) if (s.owner === owner && s.to === null) s.to = at;
    },
    contested: (owner, files, from, to, opts) => {
      const overlapping = spans.filter(
        (s) =>
          s.owner !== owner &&
          !(opts?.namedOnly && s.path === null) &&
          s.from - ACTIVITY_SLACK_MS <= to &&
          (s.to === null || s.to + ACTIVITY_SLACK_MS >= from),
      );
      if (!overlapping.length) return [];
      if (overlapping.some((s) => s.path === null)) return [...files];
      const touched = new Set(overlapping.map((s) => s.path));
      return files.filter((f) => touched.has(normActivityPath(f)));
    },
  };
}

/** The app's one log: every session runs in this window. */
export const fileActivity = createFileActivityLog();

/** The files of a command's change (relative to `workspace`) that someone other than `owner` may
 *  have written while it ran. A change without times (saved before they were) is never judged. */
export function contestedShellFiles(log: FileActivityLog, owner: string, workspace: string, change: ShellChange): string[] {
  if (change.startedAt === undefined || change.endedAt === undefined) return [];
  const root = workspace.replace(/[\\/]+$/, "");
  const byPath = new Map(change.files.map((f) => [`${root}/${f}`, f]));
  return log.contested(owner, [...byPath.keys()], change.startedAt, change.endedAt).map((p) => byPath.get(p)!);
}

/** Tools that write files they don't name: shell commands, and subagents, which run their own. */
const UNNAMED_WRITERS = new Set(["Bash", "PowerShell", "Agent", "Task", "Workflow"]);

/** Feeds a session's tool events to the log. Named edits come through `editing` (`onFileEdit`);
 *  this covers the rest. A read-only command writes nothing; a background one may go on writing
 *  after its call returns, so it stays open until the turn ends. */
export function noteToolActivity(log: FileActivityLog, owner: string, id: string, detail: ToolDetail): void {
  if (!UNNAMED_WRITERS.has(detail.name)) return;
  const background = detail.name === "Bash" && / {2}\(background\)$/.test(detail.detail);
  const command = background ? detail.detail.replace(/ {2}\(background\)$/, "") : detail.detail;
  if ((detail.name === "Bash" || detail.name === "PowerShell") && command && isAutoApprovableReadOnly(command)) return;
  if (detail.endedAt) {
    if (!background) log.close(owner, id);
    return;
  }
  log.open(owner, id);
}
