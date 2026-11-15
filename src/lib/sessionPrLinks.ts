import { updateSessionPrLinks } from "@/lib/sessionStorage";

/** A pull request, as its URL names it. `repo` is "owner/name". */
export interface PrRef {
  host: string;
  repo: string;
  number: number;
  url: string;
}

/** How the session learned about the PR:
 *  - `printed`: a PR-opening call (`gh pr create`, GitHub's MCP tool) printed its URL.
 *  - `declared`: the agent named it (`<pr-created>`).
 *  - `pushed`: a branch the session pushed turned out to have an open PR.
 *  - `tool`: found from a PR-opening call's command line (`--head`) or a CLI agent's event.
 *  - `legacy-branch`: the old `prBranch` field, looked up by branch. */
export type PrLinkSource = "printed" | "declared" | "pushed" | "tool" | "legacy-branch";

/** A PR stored in the session's meta. */
export interface SessionPrLink extends PrRef {
  source: PrLinkSource;
  /** Its head branch when it was known at link time. Only informative: the PR is read by URL. */
  branch?: string;
  /** When it was linked (ms). A PR already merged or closed before this isn't the session's. */
  linkedAt: number;
}

/** Most PRs a session keeps; the oldest links go first. */
export const MAX_SESSION_PRS = 20;

const PR_PATH_RE = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/;

/** github.com (or GHE) pull URL → ref; null if it isn't one. */
export function parsePrUrl(url: string): PrRef | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const m = PR_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const host = u.host.toLowerCase();
  const repo = `${m[1]}/${m[2].replace(/\.git$/i, "")}`;
  return { host, repo, number, url: `https://${host}/${repo}/pull/${number}` };
}

/** Same PR, whatever the URL's case or suffix. */
export const prRefKey = (ref: Pick<PrRef, "host" | "repo" | "number">): string =>
  `${ref.host.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

/** `links` plus `link`: an existing one keeps its place and source (it only picks up a branch it
 *  lacked), and past MAX_SESSION_PRS the oldest links are dropped. */
export function mergePrLinks(links: readonly SessionPrLink[], link: SessionPrLink): SessionPrLink[] {
  const key = prRefKey(link);
  const i = links.findIndex((l) => prRefKey(l) === key);
  if (i >= 0) {
    if (links[i].branch || !link.branch) return [...links];
    const next = [...links];
    next[i] = { ...links[i], branch: link.branch };
    return next;
  }
  const next = [...links, link];
  return next.length > MAX_SESSION_PRS
    ? [...next].sort((a, b) => a.linkedAt - b.linkedAt).slice(next.length - MAX_SESSION_PRS)
    : next;
}

/** Fired on window after a session is linked to a PR, so Recents and the Git bar ask GitHub right
 *  away instead of waiting for the turn to end or the next poll. */
export const PR_LINKED_EVENT = "nyxs:pr-linked";

export interface PrLinkedDetail {
  sessionId: string;
  /** The linked PR; absent for a link by branch only (an old-style `prBranch`). */
  ref?: PrRef;
  branch?: string;
}

/** Calls `cb` whenever a session gets linked to a PR; returns the unsubscribe. */
export function onPrLinked(cb: (detail: PrLinkedDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => cb((e as CustomEvent<PrLinkedDetail>).detail);
  window.addEventListener(PR_LINKED_EVENT, h);
  return () => window.removeEventListener(PR_LINKED_EVENT, h);
}

export function notifyPrLinked(detail: PrLinkedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PrLinkedDetail>(PR_LINKED_EVENT, { detail }));
}

/** Adds the PR to the session's list (dedupe by host+repo+number, max 20), persists it and fires PR_LINKED_EVENT. */
export async function linkSessionPr(
  workspace: string | null,
  sessionId: string,
  ref: PrRef,
  source: PrLinkSource,
  branch?: string,
): Promise<void> {
  const clean = parsePrUrl(ref.url) ?? ref;
  const link: SessionPrLink = {
    host: clean.host,
    repo: clean.repo,
    number: clean.number,
    url: clean.url,
    source,
    linkedAt: Date.now(),
    ...(branch ? { branch } : {}),
  };
  await updateSessionPrLinks(workspace, sessionId, (prs) => mergePrLinks(prs, link)).catch(() => undefined);
  notifyPrLinked({ sessionId, ref: clean, ...(branch ? { branch } : {}) });
}
