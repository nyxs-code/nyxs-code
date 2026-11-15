import { runGit } from "@/lib/gitErrors";

/** Where the branch pushes to and how far apart they are, as of the last fetch. */
export interface UpstreamStatus {
  /** `origin/feature`; null when the branch has no upstream yet. */
  upstream: string | null;
  /** Local commits the remote branch doesn't have. */
  ahead: number;
  /** Remote commits not pulled yet (as far as the last fetch knows). */
  behind: number;
}

export type PushResult =
  | { ok: true }
  /** The remote branch has commits we don't: pull first. */
  | { ok: false; reason: "rejected"; message: string }
  /** Git couldn't sign in to the remote. */
  | { ok: false; reason: "auth"; message: string }
  | { ok: false; reason: "other"; message: string };

export type PullResult = { ok: true } | { ok: false; reason: "conflict" | "other"; message: string };

const PUSH_TIMEOUT_MS = 120_000;

const git = (cwd: string, args: string[], timeoutMs = 15_000) => runGit(cwd, ["--no-optional-locks", ...args], timeoutMs);

/** The first lines of git's error, without the "hint:" lines that follow a rejection. */
function gitMessage(stderr: string, stdout = ""): string {
  const lines = (stderr || stdout).split("\n").map((l) => l.trimEnd()).filter((l) => l && !/^hint:/i.test(l));
  return lines.slice(0, 4).join("\n") || "git failed";
}

export function classifyPushFailure(stderr: string): PushResult {
  const message = gitMessage(stderr);
  if (/\[rejected\]|non-fast-forward|fetch first|tip of your current branch is behind|Updates were rejected/i.test(stderr)) {
    return { ok: false, reason: "rejected", message };
  }
  if (/Authentication failed|could not read Username|Permission denied|terminal prompts disabled|\b403\b|access denied/i.test(stderr)) {
    return { ok: false, reason: "auth", message };
  }
  return { ok: false, reason: "other", message };
}

export function classifyPullFailure(stderr: string, stdout = ""): PullResult {
  const text = `${stdout}\n${stderr}`;
  const message = gitMessage(stderr, stdout);
  if (/CONFLICT|Automatic merge failed|could not apply|fix conflicts/i.test(text)) return { ok: false, reason: "conflict", message };
  return { ok: false, reason: "other", message };
}

/** `git rev-list --left-right --count HEAD...<ref>` → ahead and behind. */
export function parseLeftRight(stdout: string): { ahead: number; behind: number } {
  const [a, b] = stdout.trim().split(/\s+/);
  return { ahead: Number(a) || 0, behind: Number(b) || 0 };
}

/** The branch's upstream and how far apart they are. A branch pushed without `-u` (as `gh pr
 *  create` can leave it) is compared with `origin/<branch>` and pushed with `-u` to set it. */
export async function loadUpstreamStatus(cwd: string, branch: string): Promise<UpstreamStatus | null> {
  const up = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = up.code === 0 ? up.stdout.trim() : null;
  let compare = upstream;
  if (!compare) {
    const remote = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    if (remote.code !== 0) return null;
    compare = `origin/${branch}`;
  }
  const counts = await git(cwd, ["rev-list", "--left-right", "--count", `HEAD...${compare}`]);
  if (counts.code !== 0) return null;
  return { upstream, ...parseLeftRight(counts.stdout) };
}

/** Pushes the branch: to its upstream, or to origin setting it as the upstream. */
export async function pushBranch(cwd: string, branch: string, hasUpstream: boolean): Promise<PushResult> {
  const args = hasUpstream ? ["push"] : ["push", "-u", "origin", branch];
  const r = await git(cwd, args, PUSH_TIMEOUT_MS).catch((e: unknown) => ({ code: 1, stdout: "", stderr: String(e), timed_out: false }));
  if (r.code === 0) return { ok: true };
  if (r.timed_out) return { ok: false, reason: "other", message: "git push timed out" };
  return classifyPushFailure(r.stderr);
}

/** Brings in the remote branch's commits, merging or rebasing as the user's git config says. A
 *  branch with no upstream (pushed without `-u`) names origin and the branch, since a bare
 *  `git pull` has nothing to pull from there. */
export async function pullBranch(cwd: string, branch: string, hasUpstream: boolean): Promise<PullResult> {
  const args = hasUpstream ? ["pull", "--no-edit"] : ["pull", "--no-edit", "origin", branch];
  const r = await git(cwd, args, PUSH_TIMEOUT_MS).catch((e: unknown) => ({ code: 1, stdout: "", stderr: String(e), timed_out: false }));
  if (r.code === 0) return { ok: true };
  return classifyPullFailure(r.stderr, r.stdout);
}
