import { useCallback, useSyncExternalStore } from "react";
import { runGit } from "@/lib/gitErrors";

// What the Git bar and the changes panel compare the working tree against. Both read it from
// here, with the same diff options, so the bar's +N −M is what the panel opens.

/** git's empty tree: the base for a repo with no commits yet. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Diff options both use. By content: no textconv, renames as one file, and line endings that
 *  only changed between CRLF and LF don't count (the bar offered a PR for nothing otherwise). */
export const DIFF_FLAGS = ["--no-textconv", "-M", "--ignore-cr-at-eol"];

/** Goes before the subcommand. Paths as they are (`docs/guía.md`), not quoted with an octal
 *  escape per non-ASCII byte, so the numstat and the patch name the file as the panel does. */
export const PLAIN_PATHS = ["-c", "core.quotepath=false"];

/** "uncommitted": the working tree against HEAD. "branch": against where the branch left the
 *  default branch (its merge-base), so the branch's commits count too, like Claude Desktop. */
export type DiffMode = "uncommitted" | "branch";

const git = (cwd: string, args: string[]) => runGit(cwd, ["--no-optional-locks", ...args], 15_000);

/** The default branch to compare with: what origin/HEAD points to, else origin/main or
 *  origin/master; in a repo without `origin` (or not fetched yet), a local main or master. */
export async function defaultBaseRef(cwd: string): Promise<string | null> {
  const sym = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.code === 0) return ref;
  }
  return null;
}

export interface DiffBase {
  /** What `git diff <base>` takes: a merge-base commit, HEAD, or the empty tree. */
  base: string;
  /** The default branch's ref (origin/main, main…), null when there is none. */
  baseRef: string | null;
  /** The mode actually used: "branch" falls back to "uncommitted" without a default branch to
   *  compare with. (On the default branch itself the merge-base is HEAD: both show the same.) */
  mode: DiffMode;
}

/** The base for `mode`. `hasHead` is false in a repo with no commits yet. `knownBaseRef` is a
 *  default branch the caller already looked up (or is looking up), saving git a trip. */
export async function resolveDiffBase(
  cwd: string,
  mode: DiffMode,
  hasHead: boolean,
  knownBaseRef?: Promise<string | null>,
): Promise<DiffBase> {
  if (!hasHead) return { base: EMPTY_TREE, baseRef: null, mode: "uncommitted" };
  const baseRef = await (knownBaseRef ?? defaultBaseRef(cwd));
  if (mode === "uncommitted" || !baseRef) return { base: "HEAD", baseRef, mode: "uncommitted" };
  const mergeBase = await git(cwd, ["merge-base", baseRef, "HEAD"]);
  const sha = mergeBase.code === 0 ? mergeBase.stdout.trim() : "";
  return sha ? { base: sha, baseRef, mode: "branch" } : { base: "HEAD", baseRef, mode: "uncommitted" };
}

// ── The mode, per folder ──────────────────────────────────────────────────

const MODE_KEY = "optimicer.diffMode.v1";
const listeners = new Set<() => void>();
/** Choices made while storage can't be written still hold until the page reloads. */
const unsaved: Record<string, DiffMode> = {};

function readModes(): Record<string, DiffMode> {
  try {
    const raw = JSON.parse(localStorage.getItem(MODE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v === "uncommitted" || v === "branch")) as Record<string, DiffMode>;
  } catch {
    return {};
  }
}

/** Folder paths compare without case and slash differences (Windows). */
const folderKey = (workspace: string) => workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The mode chosen in this folder; "branch" (what the bar always showed) until the user picks. */
export function diffModeFor(workspace: string | null): DiffMode {
  if (!workspace) return "branch";
  const key = folderKey(workspace);
  return unsaved[key] ?? readModes()[key] ?? "branch";
}

export function setDiffMode(workspace: string, mode: DiffMode): void {
  const key = folderKey(workspace);
  const modes = readModes();
  modes[key] = mode;
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify(modes));
    delete unsaved[key];
  } catch {
    unsaved[key] = mode;
  }
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The folder's mode, shared live by the Git bar and the changes panel. */
export function useDiffMode(workspace: string | null): [DiffMode, (mode: DiffMode) => void] {
  const mode = useSyncExternalStore(subscribe, () => diffModeFor(workspace));
  const set = useCallback((m: DiffMode) => { if (workspace) setDiffMode(workspace, m); }, [workspace]);
  return [mode, set];
}
