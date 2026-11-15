import { useSyncExternalStore } from "react";
import { accountKey } from "@/lib/accountScope";
import { parsePrUrl, prRefKey, type PrRef } from "@/lib/sessionPrLinks";

/** Auto-fix turned on for one pull request (its branch), like Claude Code Desktop's per-PR
 *  toggle: Nyxs asks the agent to fix the PR's failing checks when the Git bar sees them, and
 *  turns on that branch keep the "watch the PR" instruction. Kept across restarts. */
const KEY = "nyxs.prAutoFix.v1";
const listeners = new Set<() => void>();

const keyOf = (workspace: string, branch: string) =>
  `${workspace.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase()}\n${branch}`;

let cache: Record<string, true> | null = null;
function read(): Record<string, true> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(accountKey(KEY)) || "{}") as Record<string, true>;
  } catch {
    cache = {};
  }
  return cache;
}

export function prAutoFixOn(workspace: string | null, branch: string | null | undefined): boolean {
  return !!workspace && !!branch && !!read()[keyOf(workspace, branch)];
}

export function setPrAutoFix(workspace: string, branch: string, on: boolean): void {
  const next = { ...read() };
  if (on) next[keyOf(workspace, branch)] = true;
  else delete next[keyOf(workspace, branch)];
  cache = next;
  try {
    localStorage.setItem(accountKey(KEY), JSON.stringify(next));
  } catch {
    // Still on for this run.
  }
  listeners.forEach((l) => l());
}

export function usePrAutoFix(workspace: string | null, branch: string | null | undefined): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prAutoFixOn(workspace, branch),
  );
}

/** PR head commits whose failed checks the agent was already asked to fix (key → when). Kept
 *  across restarts, or every start would ask again for the same failure. */
const ASKED_KEY = "nyxs.prAutoFixAsked.v1";
const ASKED_MAX = 200;

let askedCache: Record<string, number> | null = null;
function readAsked(): Record<string, number> {
  if (askedCache) return askedCache;
  try {
    const raw = JSON.parse(localStorage.getItem(accountKey(ASKED_KEY)) || "{}") as unknown;
    askedCache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
  } catch {
    askedCache = {};
  }
  return askedCache;
}

export function ciFixAlreadyAsked(key: string): boolean {
  return key in readAsked();
}

export function noteCiFixAsked(key: string, at = Date.now()): void {
  const entries = Object.entries({ ...readAsked(), [key]: at })
    .sort((a, b) => b[1] - a[1])
    .slice(0, ASKED_MAX);
  askedCache = Object.fromEntries(entries);
  try {
    localStorage.setItem(accountKey(ASKED_KEY), JSON.stringify(askedCache));
  } catch {
    // Still remembered for this run.
  }
}

export interface CiFixCandidate {
  workspace: string | null;
  /** The saved session the Git bar is showing; none for a chat that isn't saved yet. */
  sessionId?: string;
  autoFix: boolean;
  pr: {
    status: string;
    number: number;
    url: string;
    head: string;
    headSha: string;
    ci: { failed: number; pending: number } | null;
  } | null;
  /** The PRs (and old-style branch) the session is linked to. */
  linked: { prs: Pick<PrRef, "host" | "repo" | "number">[]; branch: string | null };
}

/** The key to ask the agent to fix a PR's failed checks under (once per pushed commit), or ""
 *  when it shouldn't be asked: auto-fix is off, the checks haven't finished or passed, or the
 *  bar isn't on the session that opened the PR, since the prompt goes to the chat on screen and
 *  a new, empty chat must not get it. */
export function ciFixKey(c: CiFixCandidate): string {
  const { pr } = c;
  if (!c.autoFix || !c.workspace || !c.sessionId || !pr) return "";
  if (pr.status !== "open" && pr.status !== "draft") return "";
  if (!pr.ci || pr.ci.failed === 0 || pr.ci.pending > 0) return "";
  const ref = parsePrUrl(pr.url);
  const own = (ref && c.linked.prs.some((l) => prRefKey(l) === prRefKey(ref))) || c.linked.branch === pr.head;
  return own ? `${c.workspace}\n${pr.number}\n${pr.headSha}` : "";
}

/** The branch named in a turn's git context ("Branch: feat/x"). */
export const branchOfGitContext = (gitContext: string) => /^Branch: (\S+)/m.exec(gitContext)?.[1] ?? null;
