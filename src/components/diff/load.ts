import { invoke } from "@/lib/ipc";
import { classifyGitFailure, runGit, type GitFailure } from "@/lib/gitErrors";
import { DIFF_FLAGS, PLAIN_PATHS, defaultBaseRef, resolveDiffBase, type DiffMode } from "@/lib/gitBase";
import { comparePaths, parseNumstat, parsePatch, type DiffFile } from "./parse";

const MAX_UNTRACKED_DIFFS = 50;

export interface Loaded {
  branch: string;
  files: DiffFile[];
  /** The mode the files were read in, and the default branch "All branch changes" compares with. */
  mode: DiffMode;
  baseRef: string | null;
}

/** The files git doesn't track yet, each with its whole text as added lines. They don't depend on
 *  the base, so `readChanges` starts them before it knows it. */
export async function untrackedChanges(workspace: string): Promise<DiffFile[]> {
  const untracked = await runGit(workspace, ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
  const newPaths = untracked.code === 0 ? untracked.stdout.split("\0").filter(Boolean) : [];
  const newDiffs = await Promise.all(
    newPaths.slice(0, MAX_UNTRACKED_DIFFS).map((p) =>
      runGit(workspace, ["--no-optional-locks", ...PLAIN_PATHS, "diff", "--no-index", "--", "/dev/null", p]).catch(() => null),
    ),
  );
  return newPaths.map((path, i) => {
    const p = newDiffs[i] ? parsePatch(newDiffs[i]!.stdout).values().next().value : undefined;
    const added = p ? p.hunks.reduce((n, h) => n + h.rows.length, 0) : 0;
    return { path, added, removed: 0, hunks: p?.hunks ?? [], binary: p?.binary, missing: !p };
  });
}

/** The changed files against `base` (see resolveDiffBase), with the Git bar's diff options so
 *  the counts are the bar's. `untracked` is `untrackedChanges` already under way, if it is. */
export async function loadChanges(
  workspace: string,
  hideWhitespace: boolean,
  base: string,
  untracked: Promise<DiffFile[]> = untrackedChanges(workspace),
): Promise<DiffFile[]> {
  const ws = hideWhitespace ? ["-w"] : [];
  const [numstat, patch, newFiles] = await Promise.all([
    runGit(workspace, ["--no-optional-locks", ...PLAIN_PATHS, "diff", "--numstat", ...DIFF_FLAGS, ...ws, base]),
    runGit(workspace, ["--no-optional-locks", ...PLAIN_PATHS, "diff", ...DIFF_FLAGS, ...ws, base]),
    untracked,
  ]);
  const patches = parsePatch(patch.stdout);
  const files: DiffFile[] = parseNumstat(numstat.stdout).map((n) => {
    const p = patches.get(n.path);
    return { path: n.path, added: n.added, removed: n.removed, hunks: p?.hunks ?? [], binary: n.binary || p?.binary, missing: !p && !n.binary };
  });
  files.push(...newFiles);
  return files.sort((a, b) => comparePaths(a.path, b.path));
}

/** The default branch per folder: it rarely changes, and looking it up costs up to five git
 *  runs (~165 ms each on Windows) before anything else can start. Looked up again after a while. */
const BASE_REF_TTL_MS = 60_000;
const baseRefs = new Map<string, { at: number; ref: Promise<string | null> }>();
function cachedBaseRef(workspace: string): Promise<string | null> {
  const hit = baseRefs.get(workspace);
  if (hit && Date.now() - hit.at < BASE_REF_TTL_MS) return hit.ref;
  const ref = defaultBaseRef(workspace).catch(() => null);
  baseRefs.set(workspace, { at: Date.now(), ref });
  return ref;
}

export type ReadChanges = { ok: true; loaded: Loaded } | { ok: false; failure: GitFailure };

/** What the changes view shows for a folder and mode. What doesn't depend on another step runs
 *  at once: each git run is a new process, and one after another they took about a second. */
export async function readChanges(workspace: string, mode: DiffMode, hideWhitespace: boolean): Promise<ReadChanges> {
  const untracked = untrackedChanges(workspace).catch(() => [] as DiffFile[]);
  const baseRef = cachedBaseRef(workspace);
  const head = await runGit(workspace, ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"]);
  let headFailure = head.code !== 0 ? classifyGitFailure(head.stderr) : null;
  let branch = head.stdout.trim();
  if (headFailure?.kind === "no-commits") {
    const sym = await runGit(workspace, ["symbolic-ref", "--short", "HEAD"]);
    branch = sym.code === 0 ? sym.stdout.trim() : "";
    headFailure = null;
  }
  if (headFailure) return { ok: false, failure: headFailure };
  const base = await resolveDiffBase(workspace, mode, !!branch && head.code === 0, baseRef);
  const files = await loadChanges(workspace, hideWhitespace, base.base, untracked);
  const loaded: Loaded = { branch, files, mode: base.mode, baseRef: base.baseRef };
  lastLoaded.set(`${workspace}|${mode}`, loaded);
  return { ok: true, loaded };
}

/** Reads in progress, by folder, mode and whitespace option: the view opening while its read
 *  started from the button is still running waits for that one instead of starting another. */
const inFlight = new Map<string, Promise<ReadChanges>>();
export function readChangesShared(workspace: string, mode: DiffMode, hideWhitespace: boolean): Promise<ReadChanges> {
  const key = `${workspace}|${mode}|${hideWhitespace}`;
  const running = inFlight.get(key);
  if (running) return running;
  const read = readChanges(workspace, mode, hideWhitespace).finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

/** Starts reading a folder's changes before the view opens (the pointer is on its button), so
 *  it opens with them. */
export function prefetchChanges(workspace: string | null, mode: DiffMode, hideWhitespace: boolean): void {
  if (workspace) void readChangesShared(workspace, mode, hideWhitespace).catch(() => undefined);
}

// Last result per folder and mode, so reopening the panel shows it at once while it refreshes.
export const lastLoaded = new Map<string, Loaded>();

/** The working-copy text of a changed file, read once when its hidden lines are unfolded. */
const fileTextCache = new Map<string, Promise<string[] | null>>();
export function fileLines(workspace: string, path: string): Promise<string[] | null> {
  const sep = workspace.includes("\\") ? "\\" : "/";
  const abs = `${workspace.replace(/[\\/]+$/, "")}${sep}${path.replace(/\//g, sep)}`;
  let p = fileTextCache.get(abs);
  if (!p) {
    p = invoke<string | null>("agent_read_text", { path: abs })
      .then((t) => (t === null ? null : t.replace(/\r\n?/g, "\n").split("\n")))
      .catch(() => null);
    fileTextCache.set(abs, p);
    // Changes keep coming; forget it soon so the next unfold reads the current text.
    setTimeout(() => fileTextCache.delete(abs), 5000);
  }
  return p;
}
