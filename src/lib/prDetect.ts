import { runGit } from "@/lib/gitErrors";
import {
  defaultBranch,
  fetchBranchPrDetails,
  openedPrUrlsFromApiOutput,
  prLookup,
  PR_OPENING_TOOL_RE,
  type BranchPrDetails,
} from "@/lib/prArchive";
import { linkSessionPr, parsePrUrl } from "@/lib/sessionPrLinks";
import { cdTarget, resolvePath, shellSegments } from "@/lib/shellWords";

export { PR_CREATED_PROMPT, createDeclaredPrScanner, declaredPrUrls, stripPrCreatedTags } from "@/lib/prCreatedTag";

/**
 * The ways a session gets linked to a PR other than `gh pr create` printing its URL (that one is
 * prArchive's): the agent declaring it with `<pr-created>`, a branch it pushed that someone then
 * opened a PR for on the web, a PR-opening MCP tool, and Claude Code's own `code_change_published`
 * event.
 */

/** `host/owner/name` of a remote URL (https, ssh or scp-like), lowercased; null when it isn't one. */
export function remoteRepoKey(url: string): string | null {
  const u = url.trim();
  const m =
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(u) ??
    /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const parts = m[2].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // GitHub's ssh-over-443 host is still github.com.
  const host = m[1].toLowerCase() === "ssh.github.com" ? "github.com" : m[1].toLowerCase();
  return `${host}/${parts.slice(-2).join("/")}`.toLowerCase();
}

/** The repos the folder's remotes point at, as remoteRepoKey gives them. */
async function remoteRepoKeys(cwd: string): Promise<Set<string>> {
  const r = await runGit(cwd, ["remote", "-v"], 10_000).catch(() => null);
  const keys = new Set<string>();
  if (r?.code !== 0) return keys;
  for (const line of r.stdout.split("\n")) {
    const url = line.trim().split(/\s+/)[1];
    const key = url && remoteRepoKey(url);
    if (key) keys.add(key);
  }
  return keys;
}

/** Links a PR the agent declared, only when it belongs to a repo one of the folders has as a
 *  remote (as Claude Code does), so a URL the agent merely quotes can't slip in. */
export async function linkDeclaredPr(
  url: string,
  folders: (string | null | undefined)[],
  sessionWorkspace: string | null,
  sessionId: string,
): Promise<boolean> {
  const ref = parsePrUrl(url);
  if (!ref) return false;
  const key = `${ref.host}/${ref.repo}`.toLowerCase();
  for (const folder of new Set(folders.filter((f): f is string => !!f))) {
    if ((await remoteRepoKeys(folder)).has(key)) {
      await linkSessionPr(sessionWorkspace, sessionId, ref, "declared");
      return true;
    }
  }
  return false;
}

export { PR_OPENING_TOOL_RE };

/** The PR a PR-opening tool's output names: the top-level `html_url` of its JSON, never the
 *  other PRs it cites (see `openedPrUrlsFromApiOutput`). */
export function prUrlsFromToolOutput(output: string): string[] {
  const urls: string[] = [];
  for (const m of openedPrUrlsFromApiOutput(output)) {
    const ref = parsePrUrl(m);
    if (ref && !urls.includes(ref.url)) urls.push(ref.url);
  }
  return urls;
}

interface ToolCall {
  name: string;
  detail?: string;
  output?: string;
  endedAt?: number;
}

/** Hands each tool call that `matches` to `done` once, when it has ended, with its latest detail. */
function onEndedCalls(matches: (call: ToolCall) => boolean, done: (call: ToolCall) => void) {
  const latest = new Map<string, ToolCall>();
  const settled = new Set<string>();
  return (id: string, call: ToolCall): void => {
    if (settled.has(id)) {
      // The output that follows the end, before the handover runs.
      if (latest.has(id)) latest.set(id, call);
      return;
    }
    if (!matches(call)) return;
    latest.set(id, call);
    if (!call.endedAt) return;
    settled.add(id);
    // turnStream stamps the end before it adds the output, in the same tick: wait for it.
    setTimeout(() => {
      const last = latest.get(id) ?? call;
      latest.delete(id);
      done(last);
    }, 0);
  };
}

/** Follows a turn's tool calls and calls `link` with the PRs each PR-opening MCP tool printed,
 *  once, when it ends. `gh pr create` is prArchive's, not this one's. */
export function createPrToolLinker(link: (urls: string[]) => void) {
  return onEndedCalls(
    (call) => PR_OPENING_TOOL_RE.test(call.name),
    (call) => {
      const urls = prUrlsFromToolOutput(call.output ?? "");
      if (urls.length) link(urls);
    },
  );
}

/** What Claude Code's `{"type":"system","subtype":"code_change_published"}` event says. */
export interface PublishedChange {
  url: string;
  repo?: string;
  identifier?: string;
  /** `created`, `pushed`, `merged`…; absent from older producers. */
  action?: string;
  branch?: string;
}

/** Whether a Claude Code `code_change_published` event is a PR the session opened. It also fires
 *  when the session merely touches a PR (pushes to its branch, checks it out, comments, merges),
 *  and those don't make it the session's. */
export function publishedPrOpened(change: PublishedChange): boolean {
  return (change.action === undefined || change.action === "created") && !!parsePrUrl(change.url);
}

/** A branch a push sent somewhere. `remoteUrl` comes from git's `To <url>` line. */
export interface PushedBranch {
  cwd: string;
  branch: string;
  remote: string | null;
  remoteUrl: string | null;
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_FLAG_WITH_VALUE = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

/** The branch a refspec pushes to, or "HEAD" when that's only known from git's output. Tags,
 *  deletions and other refs give null. */
function refspecBranch(spec: string): string | null {
  const s = spec.replace(/^\+/, "");
  const [src, dst] = s.includes(":") ? s.split(":", 2) : [s, s];
  if (!dst) return null;
  const name = dst.replace(/^refs\/heads\//, "");
  if (name.startsWith("refs/")) return null;
  if (name === "HEAD" && src === "HEAD") return "HEAD";
  return name === "HEAD" ? src.replace(/^refs\/heads\//, "") || null : name;
}

/** The branches a command's `git push`es sent, read from the command (`git push -u origin x`,
 *  `HEAD:x`, `cd dir && git push`, `git -C dir push`) and confirmed by what git printed
 *  (`* [new branch] x -> x`, `abc..def x -> x`, `branch 'x' set up to track`). A push git
 *  rejected, a tag and a deletion give nothing. */
export function pushedBranches(command: string, output: string | undefined, workspace: string): PushedBranch[] {
  const out = output ?? "";
  let cwd = workspace;
  const fromCommand: { cwd: string; remote: string | null; branches: string[] }[] = [];
  for (const words of shellSegments(command)) {
    const dir = cdTarget(words);
    if (dir !== null) {
      cwd = resolvePath(cwd, dir);
      continue;
    }
    const gitAt = words.findIndex((w) => /^git(?:\.exe)?$/i.test(w));
    if (gitAt < 0) continue;
    let i = gitAt + 1;
    let at = cwd;
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "-C" && words[i + 1]) at = resolvePath(at, words[i + 1]);
      i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1;
    }
    if (words[i] !== "push") continue;
    const args = words.slice(i + 1);
    if (args.some((a) => /^(?:--tags|--delete|-d|--mirror|--prune)$/.test(a))) continue;
    const positional: string[] = [];
    for (let j = 0; j < args.length; j++) {
      if (PUSH_FLAG_WITH_VALUE.has(args[j])) j++;
      // Redirections (`2>&1`) aren't arguments.
      else if (!args[j].startsWith("-") && !/^\d*>/.test(args[j])) positional.push(args[j]);
    }
    const [remote = null, ...specs] = positional;
    const branches = specs.map(refspecBranch).filter((b): b is string => !!b);
    fromCommand.push({ cwd: at, remote, branches: branches.length ? branches : ["HEAD"] });
  }
  if (!fromCommand.length) return [];

  // What git printed: the branches that went, the ones it refused and where they went.
  const ok = new Set<string>();
  const rejected = new Set<string>();
  for (const m of out.matchAll(/^\s*[*+ -]?\s*(?:\[new branch\]|[0-9a-f]{4,}\.{2,3}[0-9a-f]{4,})\s+\S+\s+->\s+(\S+)/gm)) ok.add(m[1].replace(/^refs\/heads\//, ""));
  for (const m of out.matchAll(/^\s*!\s*\[(?:remote )?rejected\]\s+\S+\s+->\s+(\S+)/gm)) rejected.add(m[1]);
  for (const m of out.matchAll(/branch '([^']+)' set up to track '[^/']+\/([^']+)'/g)) ok.add(m[2]);
  const upToDate = /Everything up-to-date/i.test(out);
  const remoteUrl = /^To\s+(\S+)/m.exec(out)?.[1] ?? null;

  const found: PushedBranch[] = [];
  const add = (b: PushedBranch) => {
    if (!found.some((f) => f.cwd === b.cwd && f.branch === b.branch)) found.push(b);
  };
  for (const push of fromCommand) {
    for (const branch of push.branches) {
      if (branch === "HEAD") continue;
      if (rejected.has(branch) || !(ok.has(branch) || upToDate)) continue;
      add({ cwd: push.cwd, branch, remote: push.remote, remoteUrl });
    }
    // `git push` with no refspec, or `HEAD`: the branch is the one git says it pushed.
    if (push.branches.includes("HEAD")) {
      for (const branch of ok) {
        if (!rejected.has(branch)) add({ cwd: push.cwd, branch, remote: push.remote, remoteUrl });
      }
    }
  }
  return found;
}

/** Follows a turn's shell calls and hands over the branches each `git push` sent, once, when it
 *  ends. */
export function createPushCallTracker(workspace: string, found: (branches: PushedBranch[]) => void) {
  return onEndedCalls(
    (call) => /\bgit\b[\s\S]*\bpush\b/.test(call.detail ?? ""),
    (call) => {
      const branches = pushedBranches(call.detail ?? "", call.output, workspace);
      if (branches.length) found(branches);
    },
  );
}

/** Leeway for clocks and for a PR opened right as the session started. */
const CLOCK_SLACK_MS = 5 * 60_000;

/** Whether the PR found on a pushed branch is one opened for this session's push: created after
 *  the session started, and not merged or closed before the push. */
export function acceptPushedPr(pr: Pick<BranchPrDetails, "status" | "createdAt" | "mergedAt">, sessionStartedAt: number, pushedAt: number): boolean {
  if (pr.createdAt === undefined || pr.createdAt < sessionStartedAt - CLOCK_SLACK_MS) return false;
  if (pr.status === "open" || pr.status === "draft") return true;
  return pr.status === "merged" && pr.mergedAt !== undefined && pr.mergedAt >= pushedAt - CLOCK_SLACK_MS;
}

interface PendingPush extends PushedBranch {
  sessionId: string;
  sessionWorkspace: string | null;
  sessionStartedAt: number;
  pushedAt: number;
  lastCheck: number;
  checking: boolean;
}

/** Branches the sessions pushed that have no PR yet, while the app is open. Kept in memory: the
 *  PR this watches for is one the user opens on the web shortly after the push, while they still
 *  have the app open; a restart forgets them, which costs at most a PR opened after it. */
const pending = new Map<string, PendingPush>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Every ~30 s at first, the way Claude Code polls; less often once the push is old, and given up
 *  after a day. */
export const PUSH_CHECK_MS = 30_000;
const SLOW_CHECK_AFTER_MS = 30 * 60_000;
const SLOW_CHECK_MS = 5 * 60_000;
const PUSH_WATCH_MS = 24 * 60 * 60_000;

const pushKey = (sessionId: string, b: PushedBranch) => `${sessionId}\n${b.cwd}\n${b.remoteUrl ?? b.remote ?? ""}\n${b.branch}`;

/** Starts watching the branches a session pushed for a PR opened elsewhere (the web, an API). */
export function notePushedBranches(
  sessionId: string,
  sessionWorkspace: string | null,
  sessionStartedAt: number,
  branches: PushedBranch[],
  now = Date.now(),
): void {
  for (const b of branches) {
    const key = pushKey(sessionId, b);
    if (pending.has(key)) continue;
    pending.set(key, { ...b, sessionId, sessionWorkspace, sessionStartedAt, pushedAt: now, lastCheck: now, checking: false });
  }
  if (pending.size && !timer) timer = setInterval(() => void refreshPushedPrs(), PUSH_CHECK_MS);
}

/** Looks up the PRs of the pushed branches that are due (see PUSH_CHECK_MS) and links the ones
 *  opened for them. Safe to call often: the throttle is per branch. */
export async function refreshPushedPrs(now = Date.now()): Promise<void> {
  const due = [...pending.entries()].filter(([key, p]) => {
    if (now - p.pushedAt > PUSH_WATCH_MS) {
      pending.delete(key);
      return false;
    }
    const every = now - p.pushedAt > SLOW_CHECK_AFTER_MS ? SLOW_CHECK_MS : PUSH_CHECK_MS;
    return !p.checking && now - p.lastCheck >= every;
  });
  await Promise.all(due.map(([key, p]) => checkPush(key, p, now)));
  if (!pending.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function checkPush(key: string, p: PendingPush, now: number): Promise<void> {
  p.checking = true;
  p.lastCheck = now;
  try {
    const base = await defaultBranch(p.cwd);
    if (p.branch === base || (!base && (p.branch === "main" || p.branch === "master"))) {
      pending.delete(key);
      return;
    }
    const where = await prLookup(p.cwd, p.branch);
    // Where git said it pushed beats the branch's config (`git push other HEAD:x` sets none).
    const pushed = p.remoteUrl ? remoteRepoKey(p.remoteUrl) : null;
    const pushedRepo = pushed?.startsWith("github.com/") ? pushed.slice("github.com/".length) : null;
    const lookup = pushedRepo
      ? {
          ...where,
          head: p.branch,
          owner: pushedRepo.split("/")[0],
          repos: [...new Set([...where.repos.map((r) => r.toLowerCase()), pushedRepo])],
        }
      : { ...where, head: p.branch };
    const pr = await fetchBranchPrDetails(p.cwd, p.branch, lookup);
    if (!pr) return;
    if (acceptPushedPr(pr, p.sessionStartedAt, p.pushedAt)) {
      const ref = parsePrUrl(pr.url);
      pending.delete(key);
      if (ref) await linkSessionPr(p.sessionWorkspace, p.sessionId, ref, "pushed", pr.head || p.branch);
    } else if ((pr.status === "open" || pr.status === "draft") && pr.createdAt !== undefined && pr.createdAt < p.sessionStartedAt - CLOCK_SLACK_MS) {
      // Someone's PR that was already open: the push added to it, and no other PR can be opened
      // for the branch while it stays open.
      pending.delete(key);
    }
  } finally {
    p.checking = false;
  }
}

/** For tests: forgets every pushed branch. */
export function resetPushedBranches(): void {
  pending.clear();
  if (timer) clearInterval(timer);
  timer = null;
}

/** For tests: the branches being watched. */
export function pushedBranchesWatched(): PushedBranch[] {
  return [...pending.values()].map(({ cwd, branch, remote, remoteUrl }) => ({ cwd, branch, remote, remoteUrl }));
}
