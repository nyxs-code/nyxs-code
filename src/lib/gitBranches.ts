import { invoke } from "@/lib/ipc";
import { runGit } from "@/lib/gitErrors";

/**
 * The branch picker of the new-session composer, as Claude Code Desktop has it: with Worktree
 * off, picking a branch switches the project folder to it right away (and refuses, saying why,
 * when that could lose or tangle work); with Worktree on, it is the branch the session's
 * worktree starts from.
 */

const git = (cwd: string, args: string[], timeoutMs = 20_000) => runGit(cwd, ["--no-optional-locks", ...args], timeoutMs);

export interface FolderBranches {
  /** The checked-out branch; null on a detached HEAD. */
  current: string | null;
  /** Local branches: main and master first, then by name. */
  branches: string[];
  /** Branches another worktree of the repository has checked out, and that worktree's folder. */
  elsewhere: Map<string, string>;
  /** The folder is a linked worktree (one made for a session), not the repository's own. */
  linkedWorktree: boolean;
}

const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

/** Claude's order: main, then master, then the rest by name. */
export function sortBranches(names: string[]): string[] {
  const rank = (n: string) => (n === "main" ? 0 : n === "master" ? 1 : 2);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Null when the folder isn't a git repository with branches. */
export async function readFolderBranches(cwd: string): Promise<FolderBranches | null> {
  const [refs, head, worktrees, dirs] = await Promise.all([
    git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
    git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]),
  ]);
  if (refs.code !== 0) return null;
  const branches = refs.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (branches.length === 0) return null;
  const [top = cwd, gitDir = "", commonDir = ""] = dirs.stdout.split("\n").map((s) => s.trim());
  const elsewhere = new Map<string, string>();
  let path = "";
  for (const line of worktrees.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9).trim();
    else if (line.startsWith("branch refs/heads/") && path && norm(path) !== norm(top)) elsewhere.set(line.slice(18).trim(), path);
  }
  return {
    current: head.code === 0 ? head.stdout.trim() || null : null,
    branches: sortBranches(branches),
    elsewhere,
    linkedWorktree: dirs.code === 0 && !!gitDir && !!commonDir && norm(gitDir) !== norm(commonDir),
  };
}

/** What the folder's working tree holds that a switch would carry or lose. */
export interface WorkingTreeStatus {
  files: number;
  additions: number;
  deletions: number;
}

export async function workingTreeStatus(cwd: string): Promise<WorkingTreeStatus> {
  const [status, numstat] = await Promise.all([
    git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]),
    git(cwd, ["diff", "HEAD", "--numstat"]),
  ]);
  // -z: a rename carries its old path as one more entry, which isn't a file of its own.
  const entries = status.stdout.split("\0");
  let files = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    files++;
    if (e[0] === "R" || e[0] === "C") i++;
  }
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.split("\n")) {
    const [a, d] = line.split("\t");
    additions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return { files, additions, deletions };
}

/** A merge, rebase, cherry-pick or revert left half done. */
async function operationInProgress(cwd: string): Promise<boolean> {
  const refs = await Promise.all(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"].map((r) => git(cwd, ["rev-parse", "-q", "--verify", r])));
  if (refs.some((r) => r.code === 0)) return true;
  // A rebase stopped to edit a commit leaves no REBASE_HEAD: its folder says it.
  const dirs = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
  if (dirs.code !== 0) return false;
  const paths = dirs.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
  const found = await Promise.all(paths.map((p) => invoke<boolean>("agent_path_exists", { path: p }).catch(() => false)));
  return found.some(Boolean);
}

/** Why the folder wasn't switched; each has its own sentence in the composer's notice. */
export type SwitchRefusal =
  | "app_worktree"
  | "detached_head"
  | "operation_in_progress"
  | "branch_elsewhere"
  | "session_working"
  | "uncommitted_changes"
  | "untracked_in_the_way"
  | "changes_in_the_way"
  | "branch_missing"
  | "failed";

export type SwitchResult = { ok: true } | { ok: false; reason: SwitchRefusal; detail?: string };

/**
 * Switches the folder to `branch`. It refuses rather than carry uncommitted changes across
 * (the dialog has the user stash, commit or discard them first), and when the folder isn't on
 * a branch, has a git operation half done, or another worktree has the branch checked out.
 */
export async function switchFolderBranch(cwd: string, branch: string, opts: { sessionWorking?: boolean } = {}): Promise<SwitchResult> {
  const info = await readFolderBranches(cwd);
  if (!info) return { ok: false, reason: "failed" };
  if (info.linkedWorktree) return { ok: false, reason: "app_worktree" };
  if (!info.branches.includes(branch)) return { ok: false, reason: "branch_missing" };
  if (info.current === branch) return { ok: true };
  if (opts.sessionWorking) return { ok: false, reason: "session_working" };
  if (!info.current) return { ok: false, reason: "detached_head" };
  if (await operationInProgress(cwd)) return { ok: false, reason: "operation_in_progress" };
  if (info.elsewhere.has(branch)) return { ok: false, reason: "branch_elsewhere" };
  if ((await workingTreeStatus(cwd)).files > 0) return { ok: false, reason: "uncommitted_changes" };
  // `branch` is one of the folder's own branches, and git never lets one start with "-".
  const r = await git(cwd, ["switch", "--no-guess", branch], 60_000);
  if (r.code === 0) return { ok: true };
  const text = `${r.stderr}\n${r.stdout}`;
  if (/untracked working tree files would be overwritten/i.test(text)) return { ok: false, reason: "untracked_in_the_way", detail: text.trim() };
  if (/would be overwritten/i.test(text)) return { ok: false, reason: "changes_in_the_way", detail: text.trim() };
  if (/invalid reference|did not match|not a branch/i.test(text)) return { ok: false, reason: "branch_missing", detail: text.trim() };
  return { ok: false, reason: "failed", detail: text.trim() };
}

/** How the dialog clears uncommitted changes before a switch. */
export type DirtyAction = "stash" | "commit" | "discard";

export class GitStepError extends Error {}

async function must(cwd: string, args: string[]): Promise<void> {
  const r = await git(cwd, args, 60_000);
  if (r.code !== 0) throw new GitStepError((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
}

/** Stashes (untracked files too), commits as WIP on the branch being left, or throws away the
 *  folder's uncommitted changes. Ignored files (.env, build output) are never touched. */
export async function clearWorkingTree(cwd: string, action: DirtyAction, from: string, to: string): Promise<void> {
  if (action === "stash") {
    await must(cwd, ["stash", "push", "--include-untracked", "-m", `Nyxs: before switching to ${to}`]);
  } else if (action === "commit") {
    await must(cwd, ["add", "-A"]);
    await must(cwd, ["commit", "-m", `WIP on ${from}`]);
  } else {
    await must(cwd, ["reset", "--hard", "HEAD"]);
    await must(cwd, ["clean", "-fd"]);
  }
}
