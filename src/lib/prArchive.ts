import { invoke } from "@/lib/ipc";
import { sessionPrState, setSessionArchived, setSessionPrBranch, type SessionSummary } from "@/lib/sessionStorage";
import { runGit } from "@/lib/gitErrors";
import { linkSessionPr, notifyPrLinked, parsePrUrl, type PrRef, type SessionPrLink } from "@/lib/sessionPrLinks";
import { cdTarget, resolvePath, shellSegments } from "@/lib/shellWords";
import { uncommittedSessionFiles, uncommittedWorktreeFiles } from "@/lib/archiveGuard";
import { warnUncommittedArchive } from "@/lib/featureSettings";

export { PR_LINKED_EVENT, onPrLinked, type PrLinkedDetail } from "@/lib/sessionPrLinks";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timed_out: boolean;
}

async function runGh(args: string[], cwd: string, timeoutMs: number, ghToken?: string): Promise<RunResult | null> {
  try {
    return await invoke<RunResult>("agent_exec", { program: "gh", args, cwd, timeoutMs, ghToken: ghToken ?? null });
  } catch {
    return null;
  }
}

/** The repo exists for someone, just not for this account (gh says it can't find it). */
function cannotSeeRepo(r: RunResult): boolean {
  return r.code !== 0 && /Could not resolve to a Repository|HTTP 404|Not Found/i.test(r.stderr);
}

/** Tokens of the user's other gh accounts (`gh auth status` lists them, the active one marked). */
async function otherAccountTokens(cwd: string): Promise<string[]> {
  const status = await runGh(["auth", "status"], cwd, 10_000);
  if (!status) return [];
  const accounts: { name: string; active: boolean }[] = [];
  for (const line of `${status.stdout}\n${status.stderr}`.split("\n")) {
    const m = /Logged in to \S+ account (\S+)/.exec(line);
    if (m) accounts.push({ name: m[1], active: false });
    else if (/Active account:\s*true/i.test(line) && accounts.length) accounts[accounts.length - 1].active = true;
  }
  const tokens: string[] = [];
  for (const a of accounts.filter((x) => !x.active)) {
    const t = await runGh(["auth", "token", "--user", a.name], cwd, 10_000);
    if (t?.code === 0 && t.stdout.trim()) tokens.push(t.stdout.trim());
  }
  return tokens;
}

/** Per folder: the token of the account that can see its repo when the active one can't, or null
 *  when none could (asked again after a while, in case the user logs in). */
const accountFor = new Map<string, { token: string | null; at: number }>();
const NO_ACCOUNT_RETRY_MS = 10 * 60_000;

/** gh with the active account; a repo it can't see is tried with the user's other accounts,
 *  without switching the active one. */
async function gh(args: string[], cwd: string, timeoutMs = 20_000): Promise<RunResult | null> {
  const known = accountFor.get(cwd);
  if (known?.token) {
    const r = await runGh(args, cwd, timeoutMs, known.token);
    if (!r || !cannotSeeRepo(r)) return r;
    accountFor.delete(cwd);
  }
  const first = await runGh(args, cwd, timeoutMs);
  if (!first || !cannotSeeRepo(first)) return first;
  if (known && !known.token && Date.now() - known.at < NO_ACCOUNT_RETRY_MS) return first;
  for (const token of await otherAccountTokens(cwd)) {
    const r = await runGh(args, cwd, timeoutMs, token);
    if (r && !cannotSeeRepo(r)) {
      accountFor.set(cwd, { token, at: Date.now() });
      return r;
    }
  }
  accountFor.set(cwd, { token: null, at: Date.now() });
  return first;
}

/** The branch of a PR a command opens: the one `--head` names, the head of the PR at a URL the
 *  command printed, or the branch the repo is on. */
export type PrTarget = ({ branch: string } | { current: true }) & PrTargetWhere | { url: string };

/** Where a `gh pr create` ran: the folder it `cd`'d into (relative to the turn's folder unless
 *  absolute) and the repo `--repo` named. */
export interface PrTargetWhere {
  dir?: string;
  repo?: string;
}

/** Fired on window when something learned a branch's PR, or changed it: the Git bar read it,
 *  the agent merged it. Recents and the bar share what each one reads instead of waiting for
 *  their own next poll. */
export const PR_CHANGED_EVENT = "nyxs:pr-changed";

export interface PrChangedDetail {
  /** The PR's head branch on GitHub. */
  branch: string;
  /** What it is now, when known; absent means "ask GitHub again". */
  pr?: SessionPr | null;
  /** Who sent it, so a listener skips its own news. */
  source: "bar" | "turn";
}

export function notifyPrChanged(detail: PrChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PrChangedDetail>(PR_CHANGED_EVENT, { detail }));
}

export function onPrChanged(cb: (detail: PrChangedDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb((e as CustomEvent<PrChangedDetail>).detail);
  window.addEventListener(PR_CHANGED_EVENT, h);
  return () => window.removeEventListener(PR_CHANGED_EVENT, h);
}

/** github.com and GitHub Enterprise hosts alike: only the output of a PR-opening call is read. */
const PR_URL_RE = /https:\/\/[\w.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** The PR URLs in a command's output, first seen first. */
export function prUrlsIn(output: string): string[] {
  return [...new Set(output.match(PR_URL_RE) ?? [])];
}

/** What a finished shell call opened: the PRs at the URLs it printed (`gh pr create` ends with
 *  the new PR's URL, and names the existing one when the branch already has a PR), else what the
 *  command line says. The URL is what finds the branch when the agent ran it from another folder
 *  or its own worktree, where the session's folder is on a different branch. */
export function prTargetsFromTool(command: string, output: string | undefined): PrTarget[] {
  const opened = openedPrs(command);
  if (!opened.length) return [];
  const urls = prUrlsIn(output ?? "");
  return urls.length ? urls.map((url) => ({ url })) : opened;
}

/** A tool that opens a PR through the API instead of `gh`: GitHub's MCP server
 *  (`mcp__github__create_pull_request`) and the like. Matched on the whole of the tool's own
 *  name (`create_pull_request_review` comments on a PR, it doesn't open one), never on a command
 *  line that merely mentions it. */
export const PR_OPENING_TOOL_RE = /(?:^|_)(?:create|open)_?(?:pull_?request|pr)s?$/i;
const PR_TOOL_RE = PR_OPENING_TOOL_RE;

const PR_PAGE_RE = /^https:\/\/[\w.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** The PR a PR-opening API tool returned: its JSON's top-level `html_url`, or `url` when that is
 *  the PR's page (GitHub's newer MCP server answers just `{ id, url }`). Other URLs in the reply
 *  don't count: the PR's body may cite other PRs. A reply that isn't JSON gives its first PR. */
export function openedPrUrlsFromApiOutput(output: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(output.trim());
  } catch {
    return prUrlsIn(output).slice(0, 1);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const o = json as Record<string, unknown>;
  const page = [o.html_url, o.url].find((u): u is string => typeof u === "string" && PR_PAGE_RE.test(u));
  return page ? [page] : [];
}

/** What a finished tool call opened: the PR it returned when it is a PR-opening tool, else what
 *  `prTargetsFromTool` reads from its command. */
export function prTargetsFromCall(name: string, detail: string | undefined, output: string | undefined): PrTarget[] {
  if (PR_TOOL_RE.test(name)) return openedPrUrlsFromApiOutput(output ?? "").map((url) => ({ url }));
  return prTargetsFromTool(`${name} ${detail ?? ""}`, output);
}

const mayOpenPr = (name: string, detail: string | undefined) =>
  PR_TOOL_RE.test(name) || openedPrs(`${name} ${detail ?? ""}`).length > 0;

interface ToolCallState {
  name: string;
  detail?: string;
  output?: string;
  endedAt?: number;
}

/** Follows a turn's tool calls that `matches` and hands each one to `done` once it has ended,
 *  instead of when the turn does: a turn may go on for a long while after (watching CI, more
 *  fixes), or be stopped. `flush` hands over calls that never reported an end. Each call is
 *  handed over once. */
function createToolCallTracker(matches: (call: ToolCallState) => boolean, done: (call: ToolCallState) => void) {
  const calls = new Map<string, ToolCallState>();
  const settled = new Set<string>();
  const settle = (id: string) => {
    const call = calls.get(id);
    if (!call || settled.has(id)) return;
    settled.add(id);
    calls.delete(id);
    done(call);
  };
  return {
    onTool(id: string, detail: ToolCallState): void {
      if (settled.has(id)) return;
      if (!calls.has(id) && !matches(detail)) return;
      calls.set(id, detail);
      // turnStream stamps the end before it adds the output, in the same tick: wait for it.
      if (detail.endedAt) setTimeout(() => settle(id), 0);
    },
    flush(): void {
      for (const id of [...calls.keys()]) settle(id);
    },
  };
}

/** Hands over the PRs each `gh pr create` (or PR-opening tool) opened, as soon as that call ends. */
export function createPrCallTracker(link: (targets: PrTarget[]) => void) {
  return createToolCallTracker(
    (call) => mayOpenPr(call.name, call.detail),
    (call) => {
      const targets = prTargetsFromCall(call.name, call.detail, call.output);
      if (targets.length) link(targets);
    },
  );
}

export interface MergedPrRef {
  /** `owner/repo`, when gh printed it or the command named it with -R. */
  repo: string | null;
  number: number;
}

const mergeCommand = (command: string) => /\bgh\s+pr\s+merge\b/i.test(unquoted(command));

/** The PRs a finished `gh pr merge` merged, read from what gh printed ("✓ Squashed and merged
 *  pull request acme/app#405"). A merge it only queued (`--auto`, a merge queue) prints nothing
 *  like it, and is shown later by the Git bar when GitHub actually merges it. */
export function mergedPrsFromTool(command: string, output: string | undefined): MergedPrRef[] {
  if (!mergeCommand(command) || !output) return [];
  const args = unquoted(command).split(/\s+/);
  const named = flagValue(args, "-R", "--repo") ?? null;
  const seen = new Set<string>();
  const refs: MergedPrRef[] = [];
  for (const m of output.matchAll(/merged pull request (?:([\w.-]+\/[\w.-]+))?#(\d+)/gi)) {
    const ref = { repo: m[1] ?? named, number: Number(m[2]) };
    const key = `${ref.repo ?? ""}#${ref.number}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

/** Hands over the PRs each `gh pr merge` merged, as soon as that call ends. */
export function createMergeCallTracker(merged: (refs: MergedPrRef[]) => void) {
  return createToolCallTracker(
    (call) => mergeCommand(`${call.name} ${call.detail ?? ""}`),
    (call) => {
      const refs = mergedPrsFromTool(`${call.name} ${call.detail ?? ""}`, call.output);
      if (refs.length) merged(refs);
    },
  );
}

export interface MergedPrInfo {
  url: string;
  number: number;
  base: string;
  mergedAt: number;
  /** Its head branch, so Recents can flip the session that opened it to merged. */
  head: string;
  createdAt?: number;
}

/** A PR that is merged, with what its card shows; null when it isn't (or gh can't tell). */
export async function fetchMergedPr(workspace: string, ref: MergedPrRef): Promise<MergedPrInfo | null> {
  if (!isTauri) return null;
  const res = await gh(
    ["pr", "view", String(ref.number), "--json", "number,url,state,baseRefName,headRefName,mergedAt,createdAt", ...(ref.repo ? ["-R", ref.repo] : [])],
    workspace,
  );
  if (!res || res.code !== 0) return null;
  try {
    const j = JSON.parse(res.stdout) as {
      number?: number; url?: string; state?: string; baseRefName?: string; headRefName?: string; mergedAt?: string; createdAt?: string;
    };
    const mergedAt = j.mergedAt ? Date.parse(j.mergedAt) : NaN;
    const createdAt = j.createdAt ? Date.parse(j.createdAt) : NaN;
    if ((j.state ?? "").toUpperCase() !== "MERGED" || typeof j.number !== "number" || !j.url) return null;
    return {
      url: j.url,
      number: j.number,
      base: j.baseRefName ?? "",
      head: j.headRefName ?? "",
      mergedAt: Number.isNaN(mergedAt) ? Date.now() : mergedAt,
      createdAt: Number.isNaN(createdAt) ? undefined : createdAt,
    };
  } catch {
    return null;
  }
}

/** Why gh couldn't read a PR: not installed, no login, or no account that can see the repo. */
export type GhProblem = "missing" | "auth" | "noAccess";

export function ghProblemOf(res: RunResult | null): GhProblem | null {
  if (!res) return "missing";
  if (res.code === 0) return null;
  if (/auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(res.stderr)) return "auth";
  if (cannotSeeRepo(res)) return "noAccess";
  return null;
}

const warnedGh = new Set<string>();

/** Says once per folder why gh couldn't look a PR up, so a missing login doesn't fail silently
 *  (Recents just never shows the PR). */
function warnGhFailure(workspace: string, res: RunResult | null): void {
  const problem = ghProblemOf(res);
  const why =
    problem === "missing"
      ? "gh could not be run (is the GitHub CLI installed?)"
      : problem === "auth"
        ? `gh is not authenticated: run \`gh auth login\` (${res?.stderr.trim()})`
        : problem === "noAccess"
          ? `no gh account can see this repository (${res?.stderr.trim()})`
          : null;
  if (!why || warnedGh.has(`${workspace}\n${why}`)) return;
  warnedGh.add(`${workspace}\n${why}`);
  console.warn(`PR status for ${workspace}: ${why}`);
}

/** A stored link that names a PR (a number or its URL) instead of a branch. Release 0.8.28
 *  linked a session to any PR it merged (`gh pr merge 380`), so merging someone else's PR
 *  showed it as the session's own: those links are ignored. */
export const isMergedPrLink = (prBranch: string) => /^\d+$|^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(prBranch);

/** Quoted text is an argument, not a command: `grep 'gh pr create'` or a PR body that mentions
 *  it must not count. */
const unquoted = (command: string) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');

const flagValue = (args: string[], ...names: string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
};

/** The PRs a command opens with `gh pr create`, in order. Like Claude Code Desktop, a session
 *  shows the PR it opened and nothing else: pushing to a branch (someone else's PR included) or
 *  merging a PR doesn't make it the session's. The app's Create PR button runs this too. */
export function openedPrs(command: string): PrTarget[] {
  const targets: PrTarget[] = [];
  // The folder the command has moved to (`cd ../wt && gh pr create`), relative to where it started.
  let dir: string | null = null;
  shellSegments(command).forEach((segment, i) => {
    // The tool's name heads the line ("Bash gh pr create …").
    const words = i === 0 && SHELL_TOOL_RE.test(segment[0]) ? segment.slice(1) : segment;
    const cd = cdTarget(words);
    if (cd !== null) {
      dir = dir === null ? cd : resolvePath(dir, cd);
      return;
    }
    const at = words.findIndex((w, j) => /^gh(?:\.exe)?$/i.test(w) && words[j + 1] === "pr" && words[j + 2] === "create");
    if (at < 0) return;
    const args = words.slice(at + 3);
    const head = flagValue(args, "--head", "-H");
    const repo = flagValue(args, "--repo", "-R");
    const where = { ...(dir !== null ? { dir } : {}), ...(repo ? { repo } : {}) };
    targets.push(head ? { branch: head.replace(/^[^:]+:/, ""), ...where } : { current: true, ...where });
  });
  return targets;
}

const SHELL_TOOL_RE = /^(?:Bash|PowerShell|Shell|bash|shell|run_shell_command)$/;

/** The repo's default branch. It never has a PR of its own, so it isn't worth linking. */
export async function defaultBranch(workspace: string): Promise<string | null> {
  const res = await runGit(workspace, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], 10_000).catch(() => null);
  return res?.code === 0 ? res.stdout.trim().replace(/^[^/]+\//, "") : null;
}

/** Links the session to the PRs a PR-opening call opened (see openedPrs), so they show in Recents
 *  and the Git bar. A URL the call printed names the PR itself: it is linked as is, without asking
 *  GitHub, and is never swapped for the branch the session's folder is on, which is another one
 *  when the PR was opened from a worktree or another folder (and that worktree may be gone). A
 *  `--head` branch is looked up; the folder's own branch only when the call named nothing else. */
export async function linkOpenedPrs(
  workspace: string | null,
  sessionId: string,
  targets: PrTarget[],
  /** Where the session is saved, when the turn ran in its worktree. */
  sessionWorkspace: string | null = workspace,
): Promise<void> {
  if (!workspace) return;
  let linked = false;
  for (const t of targets) {
    if (!("url" in t)) continue;
    const ref = parsePrUrl(t.url);
    if (!ref) continue;
    await linkSessionPr(sessionWorkspace, sessionId, ref, "printed");
    linked = true;
  }
  if (!isTauri) return;
  const named = targets.filter((t): t is { branch: string } & PrTargetWhere => "branch" in t);
  const current = targets.filter((t): t is { current: true } & PrTargetWhere => "current" in t);
  if (!named.length && (linked || !current.length)) return;
  const createdAt = (await sessionPrState(sessionWorkspace, sessionId))?.createdAt;
  const link = { sessionWorkspace, sessionId, sessionCreatedAt: createdAt };
  for (const t of named) {
    const cwd = t.dir ? resolvePath(workspace, t.dir) : workspace;
    // The branch was named on the command line: it is the PR's even if GitHub can't say yet.
    if (await linkBranchPr(cwd, t.branch, t.repo, { ...link, keepBranchIfUnknown: true })) linked = true;
  }
  if (linked) return;
  // Last resort: the branch of the folder the command ran in. It is linked only to a PR GitHub
  // shows for it: a guess at a branch is what linked #456's session to the wrong one. A PR that
  // shows up later is caught by the pushed-branch watch (prDetect).
  for (const t of current) {
    const cwd = t.dir ? resolvePath(workspace, t.dir) : workspace;
    const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], 10_000).catch(() => null);
    const branch = head?.code === 0 ? head.stdout.trim() : "";
    if (branch && (await linkBranchPr(cwd, branch, t.repo, { ...link, keepBranchIfUnknown: false }))) return;
  }
}

/** Links the open PR of `branch` that the session opened. With `keepBranchIfUnknown`, when GitHub
 *  can't say (no PR yet, gh failing) the branch itself is linked the old way and looked up later.
 *  Returns whether anything was linked. */
async function linkBranchPr(
  cwd: string,
  branch: string,
  repo: string | undefined,
  opts: { sessionWorkspace: string | null; sessionId: string; sessionCreatedAt: number | undefined; keepBranchIfUnknown: boolean },
): Promise<boolean> {
  if (!branch || branch === "HEAD") return false;
  const base = await defaultBranch(cwd);
  if (branch === base || (!base && (branch === "main" || branch === "master"))) return false;
  const lookup = repo ? { ...(await prLookup(cwd, branch)), repos: [repo] } : undefined;
  const pr = await fetchBranchPrDetails(cwd, branch, lookup);
  if (pr) {
    const mine =
      opts.sessionCreatedAt === undefined || prBelongsToSession({ createdAt: opts.sessionCreatedAt, prPushed: true }, pr);
    const ref = parsePrUrl(pr.url);
    if (!mine || !ref || (pr.status !== "open" && pr.status !== "draft")) return false;
    await linkSessionPr(opts.sessionWorkspace, opts.sessionId, ref, "tool", pr.head || branch);
    return true;
  }
  if (!opts.keepBranchIfUnknown) return false;
  await setSessionPrBranch(opts.sessionWorkspace, opts.sessionId, branch);
  notifyPrLinked({ sessionId: opts.sessionId, branch });
  return true;
}

export type PrStatus = "open" | "draft" | "merged" | "closed";

export interface SessionPr {
  status: PrStatus;
  number: number;
  url: string;
  /** When the PR was opened (ms), when GitHub says. */
  createdAt?: number;
}

/** What reading a linked PR by its URL gave: the PR, or why gh couldn't tell. */
export interface PrReading {
  pr: BranchPrDetails | null;
  problem: GhProblem | null;
}

/** A linked PR, read by its URL: it doesn't need the branch, the worktree or even the folder's
 *  remote, so it keeps working after the worktree the PR was opened from is deleted. */
export async function fetchPrByUrl(workspace: string, url: string): Promise<PrReading> {
  if (!isTauri) return { pr: null, problem: null };
  const res = await gh(["pr", "view", url, "--json", PR_LIST_FIELDS], workspace);
  if (!res || res.code !== 0) {
    warnGhFailure(workspace, res);
    return { pr: null, problem: ghProblemOf(res) };
  }
  try {
    return { pr: toDetails(JSON.parse(res.stdout) as PrListItem, ""), problem: null };
  } catch {
    return { pr: null, problem: null };
  }
}

/** A PR that was already merged or closed when the session linked it isn't one it opened (a
 *  branch pushed long after its PR was merged, a URL the agent only mentioned). */
export function prFinishedBeforeLink(link: Pick<SessionPrLink, "linkedAt">, pr: Pick<BranchPrDetails, "status" | "mergedAt" | "closedAt">): boolean {
  if (pr.status !== "merged" && pr.status !== "closed") return false;
  const at = pr.mergedAt ?? pr.closedAt;
  return at !== undefined && at < link.linkedAt - PR_CLOCK_SLACK_MS;
}

/** The PR to show for a session out of all of its own: open first, then draft, merged and closed;
 *  the newest within each. */
export function mostRelevantPr<T extends Pick<SessionPr, "status" | "createdAt" | "number">>(prs: readonly T[]): T | null {
  const rank: Record<PrStatus, number> = { open: 0, draft: 1, merged: 2, closed: 3 };
  return (
    [...prs].sort(
      (a, b) => rank[a.status] - rank[b.status] || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.number - a.number,
    )[0] ?? null
  );
}

export type { PrRef, SessionPrLink };

export interface CiCounts {
  pending: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface BranchPrDetails extends SessionPr {
  base: string;
  head: string;
  /** Null when the PR has no checks at all. */
  ci: CiCounts | null;
  /** GitHub merges it on its own once checks pass ("Merge when ready"). */
  autoMerge: boolean;
  /** The commit at the PR's head, so a failure is acted on once per push. */
  headSha: string;
  /** When it was merged (ms), for a merged PR. */
  mergedAt?: number;
  /** When it was closed (ms); merged PRs have it too. */
  closedAt?: number;
}

interface RollupItem {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

/** Check runs (GitHub Actions…) and commit statuses (older CI integrations) in four buckets. */
export function countChecks(rollup: RollupItem[]): CiCounts | null {
  if (!rollup.length) return null;
  const ci: CiCounts = { pending: 0, passed: 0, failed: 0, skipped: 0 };
  for (const item of rollup) {
    if (item.__typename === "StatusContext" || (item.state && !item.status)) {
      const s = (item.state ?? "").toUpperCase();
      if (s === "SUCCESS") ci.passed++;
      else if (s === "FAILURE" || s === "ERROR") ci.failed++;
      else ci.pending++;
      continue;
    }
    if ((item.status ?? "").toUpperCase() !== "COMPLETED") { ci.pending++; continue; }
    const c = (item.conclusion ?? "").toUpperCase();
    if (c === "SUCCESS") ci.passed++;
    else if (c === "SKIPPED" || c === "NEUTRAL") ci.skipped++;
    else ci.failed++;
  }
  return ci;
}

const GITHUB_REMOTE_RE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args, 10_000).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : "";
}

/** `owner/repo` of a remote that points at GitHub. */
async function remoteRepo(cwd: string, remote: string): Promise<string | null> {
  const m = GITHUB_REMOTE_RE.exec(await gitOut(cwd, ["remote", "get-url", remote]));
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface PrLookup {
  /** The branch's name on GitHub. */
  head: string;
  /** Who owns the repo the branch is pushed to, so a same-named branch in someone's fork isn't taken. */
  owner: string | null;
  /** Where its PR can be, most likely first; empty when no remote is on github.com (gh then
   *  picks the repo itself, which covers GitHub Enterprise). */
  repos: string[];
  /** A fork: `upstream` is another repo than the one the branch is pushed to. Its PRs can come
   *  from the fork's default branch too. */
  fork: boolean;
}

/** Where to look for a branch's PR. The local name isn't always the name on GitHub
 *  (`git push -u origin fix:feature`), and a fork's PRs live in `upstream`, not in origin. */
export async function prLookup(cwd: string, branch: string): Promise<PrLookup> {
  const cfg = (key: string) => gitOut(cwd, ["config", "--get", key]);
  const [pushRemote, pushDefault, trackRemote, merge] = await Promise.all([
    cfg(`branch.${branch}.pushRemote`),
    cfg("remote.pushDefault"),
    cfg(`branch.${branch}.remote`),
    cfg(`branch.${branch}.merge`),
  ]);
  const remote = pushRemote || pushDefault || trackRemote || "origin";
  // The tracked name is the pushed one only when both go to the same remote: a fork branch that
  // tracks upstream/main but pushes to origin keeps its own name.
  const head = (trackRemote === remote && merge.replace(/^refs\/heads\//, "")) || branch;
  const [headRepo, upstream, origin] = await Promise.all([
    remoteRepo(cwd, remote),
    remoteRepo(cwd, "upstream"),
    remote === "origin" ? Promise.resolve(null) : remoteRepo(cwd, "origin"),
  ]);
  const repos = [...new Set([upstream, headRepo, origin].filter((r): r is string => !!r))];
  return {
    head,
    owner: headRepo?.split("/")[0] ?? null,
    repos,
    fork: !!upstream && !!headRepo && upstream.toLowerCase() !== headRepo.toLowerCase(),
  };
}

const PR_LIST_FIELDS =
  "number,state,isDraft,url,createdAt,mergedAt,closedAt,baseRefName,headRefName,headRepositoryOwner,statusCheckRollup,autoMergeRequest,headRefOid";

interface PrListItem {
  state?: string; isDraft?: boolean; number?: number; url?: string; createdAt?: string; mergedAt?: string | null; closedAt?: string | null;
  baseRefName?: string; headRefName?: string; headRepositoryOwner?: { login?: string } | null;
  statusCheckRollup?: RollupItem[] | null; autoMergeRequest?: unknown; headRefOid?: string;
}

function toDetails(j: PrListItem, head: string): BranchPrDetails | null {
  const state = (j.state ?? "").toUpperCase();
  const status: PrStatus | null =
    state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : state === "OPEN" ? (j.isDraft ? "draft" : "open") : null;
  if (!status || typeof j.number !== "number") return null;
  const createdAt = j.createdAt ? Date.parse(j.createdAt) : NaN;
  const mergedAt = j.mergedAt ? Date.parse(j.mergedAt) : NaN;
  const closedAt = j.closedAt ? Date.parse(j.closedAt) : NaN;
  return {
    status,
    number: j.number,
    url: j.url ?? "",
    createdAt: Number.isNaN(createdAt) ? undefined : createdAt,
    base: j.baseRefName ?? "",
    head: j.headRefName ?? head,
    ci: countChecks(j.statusCheckRollup ?? []),
    autoMerge: !!j.autoMergeRequest,
    headSha: j.headRefOid ?? "",
    mergedAt: Number.isNaN(mergedAt) ? undefined : mergedAt,
    closedAt: Number.isNaN(closedAt) ? undefined : closedAt,
  };
}

/** The PR to show out of a branch's PRs: an open one before an old merged or closed one, and
 *  only from the owner's repo when it is known. */
export function pickBranchPr(items: PrListItem[], head: string, owner: string | null): BranchPrDetails | null {
  const mine = items.filter((j) => !owner || !j.headRepositoryOwner?.login || j.headRepositoryOwner.login.toLowerCase() === owner.toLowerCase());
  const prs = mine.map((j) => toDetails(j, head)).filter((p): p is BranchPrDetails => !!p);
  const byNewest = (a: BranchPrDetails, b: BranchPrDetails) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  return prs.filter((p) => p.status === "open" || p.status === "draft").sort(byNewest)[0] ?? prs.sort(byNewest)[0] ?? null;
}

/** The branch's PR with what the bar above the composer shows: both branches and its checks.
 *  `branch` is a local branch (its push config says where its PR is) or a name on GitHub. */
export async function fetchBranchPrDetails(workspace: string, branch: string, lookup?: PrLookup): Promise<BranchPrDetails | null> {
  if (!isTauri) return null;
  const where = lookup ?? (await prLookup(workspace, branch));
  // Every repo at once (a fork's upstream and origin): the first one in order with a PR wins.
  const found = await Promise.all(
    (where.repos.length ? where.repos : [null]).map(async (repo) => {
      const res = await gh(
        ["pr", "list", "--head", where.head, "--state", "all", "--limit", "20", "--json", PR_LIST_FIELDS, ...(repo ? ["-R", repo] : [])],
        workspace,
      );
      if (!res || res.code !== 0) {
        warnGhFailure(workspace, res);
        return null;
      }
      try {
        return pickBranchPr(JSON.parse(res.stdout) as PrListItem[], where.head, where.owner);
      } catch {
        return null;
      }
    }),
  );
  return found.find((pr) => !!pr) ?? null;
}

export type AutoMergeResult = { ok: true; merged?: boolean } | { ok: false; reason: "notAllowed" | "other"; message: string };

/** "Merge when ready", like Claude Code Desktop: turns on GitHub's auto-merge for the PR (its
 *  URL, which also finds a fork's PR in upstream) with a squash, or the base branch's merge queue
 *  when it has one; a PR that is already ready is merged right away. Off turns auto-merge back off. */
export async function setPrAutoMerge(workspace: string, prUrl: string, on: boolean): Promise<AutoMergeResult> {
  if (!isTauri) return { ok: false, reason: "other", message: "" };
  const run = (args: string[]) => gh(["pr", "merge", prUrl, ...args], workspace, 30_000);
  const fail = (r: RunResult | null): AutoMergeResult => {
    const message = (r?.stderr || r?.stdout || "").trim();
    return { ok: false, reason: /auto.?merge is not allowed|enablePullRequestAutoMerge/i.test(message) ? "notAllowed" : "other", message };
  };
  if (!on) {
    const r = await run(["--disable-auto"]);
    return r?.code === 0 ? { ok: true } : fail(r);
  }
  let r = await run(["--auto", "--squash"]);
  // A merge queue sets the strategy itself and refuses one given here.
  if (r && r.code !== 0 && /merge queue/i.test(r.stderr)) r = await run(["--auto"]);
  if (r?.code === 0) return { ok: true };
  // Nothing left to wait for: GitHub won't queue an auto-merge, so merge it now.
  if (r && /clean status|is not in the correct state to enable auto.?merge/i.test(r.stderr)) {
    const now = await run(["--squash"]);
    return now?.code === 0 ? { ok: true, merged: true } : fail(now);
  }
  return fail(r);
}

/** Leeway for clocks and for a PR opened by the session's very first turn. */
const PR_CLOCK_SLACK_MS = 5 * 60_000;

/** Whether the PR found for a session's branch is really that session's: one it opened, so not
 *  older than the session. Older releases linked sessions that only pushed to a branch, such as
 *  fixes on a teammate's PR, and this keeps that PR from showing as theirs. When GitHub gives no
 *  date, a link the session recorded itself is trusted. */
export function prBelongsToSession(session: Pick<SessionSummary, "createdAt" | "prPushed">, pr: Pick<SessionPr, "createdAt">): boolean {
  if (pr.createdAt === undefined) return !!session.prPushed;
  return pr.createdAt >= session.createdAt - PR_CLOCK_SLACK_MS;
}

/** What a session is linked to, as Recents, the bar and auto-archive read it. */
export type PrSession = Pick<SessionSummary, "id" | "createdAt" | "prs" | "prBranch" | "prPushed"> & { workspace: string };

/** One of a session's PRs, read from GitHub. */
export interface SessionPrReading {
  /** The stored link; null for an old-style link by branch (`branch`). */
  link: SessionPrLink | null;
  branch?: string;
  /** Null when gh couldn't read it (`problem` says why, when it knows) or, for a branch, when
   *  the branch has no PR. */
  pr: BranchPrDetails | null;
  problem: GhProblem | null;
}

/** The old `prBranch` link, unless it is one of 0.8.28's links to merged PRs. */
export const legacyPrBranch = (s: Pick<SessionSummary, "prBranch">): string | null =>
  s.prBranch && !isMergedPrLink(s.prBranch) ? s.prBranch : null;

export const hasPrLinks = (s: Pick<SessionSummary, "prs" | "prBranch">): boolean => !!s.prs?.length || !!legacyPrBranch(s);

/** Whether a reading is one of the session's own PRs. */
export function readingCounts(session: Pick<SessionSummary, "createdAt" | "prPushed">, r: SessionPrReading): boolean {
  if (!r.pr) return false;
  return r.link ? !prFinishedBeforeLink(r.link, r.pr) : prBelongsToSession(session, r.pr);
}

/** The session's PR that Recents and the Git bar show, out of its readings: the most relevant
 *  of its own (see mostRelevantPr). Both go through here so they never disagree. */
export function pickSessionPr(session: Pick<SessionSummary, "createdAt" | "prPushed">, readings: SessionPrReading[]): BranchPrDetails | null {
  return mostRelevantPr(readings.filter((r) => readingCounts(session, r)).map((r) => r.pr!));
}

/** The PR the Git bar shows: the open PR of the checked-out branch (`own`) first, else the
 *  session's PR Recents shows (pickSessionPr) when it is open; then a merged one, for its card.
 *  `unread` is a linked PR gh couldn't read, shown with why when nothing open was found. */
export function pickBarPr(
  own: BranchPrDetails | null,
  checkedOut: string,
  session: Pick<SessionSummary, "createdAt" | "prPushed">,
  readings: SessionPrReading[],
): { pr: BranchPrDetails | null; local: boolean; unread: (SessionPrReading & { link: SessionPrLink }) | null } {
  const open = (p: BranchPrDetails | null) => p?.status === "open" || p?.status === "draft";
  if (own && open(own)) return { pr: own, local: true, unread: null };
  const chosen = pickSessionPr(session, readings);
  if (chosen && open(chosen)) return { pr: chosen, local: chosen.head === checkedOut, unread: null };
  const unread = newestUnreadLink(readings);
  if (own?.status === "merged") return { pr: own, local: true, unread };
  if (chosen?.status === "merged") return { pr: chosen, local: false, unread };
  return { pr: null, local: false, unread };
}

/** The newest link gh couldn't read, so its PR shows (with why) instead of vanishing. */
export function newestUnreadLink(readings: SessionPrReading[]): (SessionPrReading & { link: SessionPrLink }) | null {
  return (
    readings
      .filter((r): r is SessionPrReading & { link: SessionPrLink } => !r.pr && !!r.link)
      .sort((a, b) => b.link.linkedAt - a.link.linkedAt)[0] ?? null
  );
}

/** Reads one link: a PR by its URL, an old-style link by its branch. */
export async function readPrLink(workspace: string, link: SessionPrLink | null, branch?: string): Promise<SessionPrReading> {
  if (link) {
    const { pr, problem } = await fetchPrByUrl(workspace, link.url);
    return { link, pr, problem };
  }
  const pr = branch ? await fetchBranchPrDetails(workspace, branch) : null;
  return { link: null, branch, pr, problem: null };
}

/** Every PR of the session, read straight from GitHub (sessionPrs keeps a cached reader). */
export async function readSessionPrsDirect(s: PrSession): Promise<SessionPrReading[]> {
  const legacy = legacyPrBranch(s);
  return Promise.all([
    ...(s.prs ?? []).map((link) => readPrLink(s.workspace, link)),
    ...(legacy ? [readPrLink(s.workspace, null, legacy)] : []),
  ]);
}

export interface AutoArchiveOptions {
  /** Sessions to leave alone right now: the one on screen and those with a turn running. */
  skip?: (id: string) => boolean;
  now?: number;
}

/** Work in a session this long after its last PR was merged means it went on to something else. */
const WORKED_AFTER_MERGE_MS = 15 * 60_000;

/** Sessions auto-archive has archived once (id → when). One the user brought back stays back. */
const AUTO_ARCHIVED_KEY = "nyxs.prAutoArchived";
const AUTO_ARCHIVED_MAX = 500;

function autoArchivedIds(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTO_ARCHIVED_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function rememberAutoArchived(id: string, at: number): void {
  try {
    const entries = Object.entries({ ...autoArchivedIds(), [id]: at })
      .sort((a, b) => b[1] - a[1])
      .slice(0, AUTO_ARCHIVED_MAX);
    localStorage.setItem(AUTO_ARCHIVED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage full or off: at worst a session brought back is archived once more.
  }
}

/** Files the session left uncommitted, when archiving should warn about them (as by hand). */
async function uncommittedFiles(s: SessionSummary & { workspace: string }): Promise<string[]> {
  if (!warnUncommittedArchive()) return [];
  const files = s.worktree?.path ? uncommittedWorktreeFiles(s.worktree.path) : uncommittedSessionFiles(s.workspace, s.id);
  return files.catch(() => []);
}

/** Archives the sessions whose PRs are all merged or closed. A PR gh couldn't read keeps its
 *  session: it may well be open. So does a session `skip` names, one worked in after the merge,
 *  one with uncommitted changes, and one this already archived that the user brought back. */
export async function autoArchiveMergedSessions(
  sessions: SessionSummary[],
  read: (s: PrSession) => Promise<SessionPrReading[]> = readSessionPrsDirect,
  opts: AutoArchiveOptions = {},
): Promise<Array<{ id: string; workspace: string }>> {
  if (!isTauri) return [];
  const before = autoArchivedIds();
  const candidates = sessions.filter(
    (s): s is SessionSummary & { workspace: string } =>
      !!s.workspace && !s.archived && hasPrLinks(s) && !opts.skip?.(s.id) && !(s.id in before),
  );
  const archived: Array<{ id: string; workspace: string }> = [];
  await Promise.all(
    candidates.map(async (s) => {
      const finished = await prsFinishedAt(s, read);
      if (finished === null) return;
      if (finished !== undefined && s.modifiedAt > finished + WORKED_AFTER_MERGE_MS) return;
      if ((await uncommittedFiles(s)).length) return;
      const now = opts.now ?? Date.now();
      await setSessionArchived(s.workspace, s.id, true, now);
      rememberAutoArchived(s.id, now);
      archived.push({ id: s.id, workspace: s.workspace });
    }),
  );
  return archived;
}

/** When the last of the session's own PRs was merged or closed (undefined when GitHub didn't
 *  say), or null while one is open or can't be read. */
async function prsFinishedAt(
  s: PrSession,
  read: (s: PrSession) => Promise<SessionPrReading[]>,
): Promise<number | undefined | null> {
  const readings = await read(s);
  if (!readings.length || readings.some((r) => !r.pr)) return null;
  const own = readings.filter((r) => readingCounts(s, r));
  if (!own.length || !own.every((r) => r.pr!.status === "merged" || r.pr!.status === "closed")) return null;
  const times = own.map((r) => r.pr!.mergedAt ?? r.pr!.closedAt).filter((t): t is number => t !== undefined);
  return times.length ? Math.max(...times) : undefined;
}

export async function allPrsFinished(
  s: PrSession,
  read: (s: PrSession) => Promise<SessionPrReading[]> = readSessionPrsDirect,
): Promise<boolean> {
  return (await prsFinishedAt(s, read)) !== null;
}
