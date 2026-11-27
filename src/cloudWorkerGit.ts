import { invoke } from "@/lib/ipc";

/** What `agent_exec` returns. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
}

/** Runs git or gh (the only programs `agent_exec` runs directly); swapped in tests. */
export type CloudExec = (program: "git" | "gh", args: string[], cwd: string, timeoutMs?: number) => Promise<ExecResult>;

export const tauriExec: CloudExec = (program, args, cwd, timeoutMs) =>
  invoke<ExecResult>("agent_exec", { program, args, cwd, timeoutMs: timeoutMs ?? 120_000, ghToken: null });

/** git's credential helper for GitHub: the token comes from `GITHUB_TOKEN` when git asks, so it is
 *  never in a URL, an argument or the clone's config. The empty helper first drops any other. */
const CREDENTIAL_HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
export const GIT_AUTH = ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`];

const CLONE_TIMEOUT_MS = 15 * 60_000;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const AUTHOR = { name: "Nyxs", email: "noreply@nyxs.dev" };

export class CloudGitError extends Error {}

export interface RepoJob {
  threadId: string;
  turn: number;
  repo: { url: string; branch?: string | null };
  workBranch: string;
}

export interface PreparedRepo {
  dir: string;
  /** The branch the work branch started from, and the pull request's base. */
  base: string;
  cloned: boolean;
}

export interface FinishedRepo {
  /** The turn left commits the remote branch doesn't have yet (or had them before pushing). */
  changed: boolean;
  pushed: boolean;
  prUrl?: string;
  /** Why the work couldn't be published, when it couldn't. */
  error?: string;
}

function fail(what: string, r: ExecResult): never {
  const why = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
  throw new CloudGitError(`${what}${r.timed_out ? " (timed out)" : ""}: ${why || `exit ${r.code}`}`);
}

async function must(exec: CloudExec, what: string, args: string[], cwd: string, timeoutMs?: number): Promise<ExecResult> {
  const r = await exec("git", args, cwd, timeoutMs);
  if (r.code !== 0) fail(what, r);
  return r;
}

const ok = async (exec: CloudExec, args: string[], cwd: string) => (await exec("git", args, cwd)).code === 0;

/** Clones the repo into `<work>/repo` on the first turn (fetches on the next ones) and checks out
 *  the work branch: the local one when a turn made it, else the remote one, else a new one from
 *  the base branch. Whatever a failed turn left uncommitted stays for the next. */
export async function prepareRepo(job: RepoJob, work: string, exec: CloudExec): Promise<PreparedRepo> {
  const dir = `${work.replace(/[\\/]+$/, "")}/repo`;
  const cloned = !(await ok(exec, ["-C", dir, "rev-parse", "--is-inside-work-tree"], work));
  if (cloned) {
    const branch = job.repo.branch ? ["--branch", job.repo.branch] : [];
    await must(exec, "Couldn't clone the repository", [...GIT_AUTH, "clone", "--filter=blob:none", ...branch, "--", job.repo.url, dir], work, CLONE_TIMEOUT_MS);
  } else {
    await must(exec, "Couldn't fetch the repository", [...GIT_AUTH, "fetch", "--prune", "origin"], dir, NETWORK_TIMEOUT_MS);
  }
  await must(exec, "Couldn't set the commit author", ["config", "user.name", AUTHOR.name], dir);
  await must(exec, "Couldn't set the commit author", ["config", "user.email", AUTHOR.email], dir);
  const base = job.repo.branch || (await defaultBranch(exec, dir));
  const wb = job.workBranch;
  const current = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir)).stdout.trim();
  if (current !== wb) {
    if (await ok(exec, ["rev-parse", "--verify", "--quiet", `refs/heads/${wb}`], dir)) {
      await must(exec, "Couldn't switch to the work branch", ["checkout", wb], dir);
    } else if (await ok(exec, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wb}`], dir)) {
      await must(exec, "Couldn't switch to the work branch", ["checkout", "-b", wb, "--track", `origin/${wb}`], dir);
    } else {
      await must(exec, "Couldn't create the work branch", ["checkout", "--no-track", "-b", wb, `origin/${base}`], dir);
    }
  }
  return { dir, base, cloned };
}

async function defaultBranch(exec: CloudExec, dir: string): Promise<string> {
  const r = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
  const name = r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "";
  return name || "main";
}

export interface PublishInput {
  title: string;
  body: string;
  /** `GITHUB_TOKEN` is set; without it the work stays committed in the thread's volume. */
  canPush: boolean;
}

/** Commits what the turn changed, pushes the work branch and opens a draft pull request for it,
 *  or finds the one an earlier turn opened (pushing updates it). Never force-pushes. */
export async function publishRepo(job: RepoJob, repo: PreparedRepo, input: PublishInput, exec: CloudExec): Promise<FinishedRepo> {
  const { dir, base } = repo;
  const wb = job.workBranch;
  const status = await must(exec, "Couldn't read the changes", ["status", "--porcelain"], dir);
  if (status.stdout.trim()) {
    await must(exec, "Couldn't stage the changes", ["add", "-A"], dir);
    const message = `${input.title}\n\nTurn ${job.turn} of Nyxs cloud thread ${job.threadId}.`;
    await must(exec, "Couldn't commit the changes", ["commit", "-q", "-m", message], dir);
  }
  const remoteHasBranch = await ok(exec, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wb}`], dir);
  const since = remoteHasBranch ? `origin/${wb}` : `origin/${base}`;
  const ahead = Number((await must(exec, "Couldn't compare with the remote", ["rev-list", "--count", `${since}..HEAD`], dir)).stdout.trim()) || 0;
  if (ahead === 0) {
    // Nothing new; a pull request from an earlier turn is still the thread's, and its body gets
    // this turn's line.
    const prUrl = remoteHasBranch && input.canPush ? await findPr(exec, dir, wb) : undefined;
    if (prUrl) await editPr(exec, dir, prUrl, input);
    return { changed: false, pushed: false, ...(prUrl ? { prUrl } : {}) };
  }
  if (!input.canPush) return { changed: true, pushed: false, error: "No GITHUB_TOKEN: the work is committed on the branch but not pushed." };
  const push = await exec("git", [...GIT_AUTH, "push", "-q", "-u", "origin", `HEAD:refs/heads/${wb}`], dir, NETWORK_TIMEOUT_MS);
  if (push.code !== 0) {
    const why = (push.stderr || push.stdout).trim().split("\n").slice(-4).join("\n");
    return { changed: true, pushed: false, error: `Couldn't push ${wb}: ${why}` };
  }
  const existing = await findPr(exec, dir, wb);
  if (existing) {
    const edited = await editPr(exec, dir, existing, input);
    return { changed: true, pushed: true, prUrl: existing, ...(edited ? {} : { error: `Pushed ${wb}, but couldn't update the pull request's description.` }) };
  }
  const created = await exec("gh", ["pr", "create", "--draft", "--head", wb, "--base", base, "--title", input.title, "--body", input.body], dir, NETWORK_TIMEOUT_MS);
  const prUrl = /https:\/\/\S+\/pull\/\d+/.exec(created.stdout)?.[0];
  if (created.code !== 0 || !prUrl) {
    const why = (created.stderr || created.stdout).trim().split("\n").slice(-4).join("\n");
    return { changed: true, pushed: true, error: `Pushed ${wb}, but couldn't open the pull request: ${why}` };
  }
  return { changed: true, pushed: true, prUrl };
}

/** Writes the thread's title and summary over the pull request's; false when gh couldn't. */
async function editPr(exec: CloudExec, dir: string, url: string, input: PublishInput): Promise<boolean> {
  const r = await exec("gh", ["pr", "edit", url, "--title", input.title, "--body", input.body], dir, NETWORK_TIMEOUT_MS);
  return r.code === 0;
}

async function findPr(exec: CloudExec, dir: string, branch: string): Promise<string | undefined> {
  const r = await exec("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--limit", "1"], dir, NETWORK_TIMEOUT_MS);
  if (r.code !== 0) return undefined;
  try {
    const list = JSON.parse(r.stdout) as { url?: string }[];
    return list[0]?.url || undefined;
  } catch {
    return undefined;
  }
}
