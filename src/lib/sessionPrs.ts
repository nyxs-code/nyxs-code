import { useEffect, useState } from "react";
import {
  hasPrLinks,
  legacyPrBranch,
  newestUnreadLink,
  onPrChanged,
  onPrLinked,
  pickSessionPr,
  readPrLink,
  type GhProblem,
  type PrSession,
  type SessionPr,
  type SessionPrReading,
} from "@/lib/prArchive";
import { parsePrUrl, prRefKey, type SessionPrLink } from "@/lib/sessionPrLinks";
import type { SessionSummary } from "@/lib/sessionStorage";

/** How often the list re-checks. Only PRs whose reading has gone stale are asked again. */
const TICK_MS = 10_000;
/** How long a reading stays good, by what it said. An open PR is the one that changes (it gets
 *  merged or closed, usually on GitHub), so it is re-read every few seconds and right away when
 *  the window regains focus — that is when someone comes back from merging it. A merged PR is
 *  final and isn't asked again; a closed one can be reopened, so it is asked now and then. What
 *  the Git bar or the agent learn arrives sooner still, through onPrChanged. */
const OPEN_TTL_MS = 15_000;
const OPEN_FOCUS_TTL_MS = 2_000;
/** A branch without a PR yet: one gets opened. */
const NONE_TTL_MS = 30_000;
const CLOSED_TTL_MS = 10 * 60_000;
/** gh failed (no login, offline): asked again after a while, in case the user fixes it. */
const FAILED_TTL_MS = 2 * 60_000;

type Reason = "tick" | "focus";

function ttlFor(r: SessionPrReading, reason: Reason): number {
  if (!r.pr) return r.link ? FAILED_TTL_MS : NONE_TTL_MS;
  if (r.pr.status === "open" || r.pr.status === "draft") return reason === "focus" ? OPEN_FOCUS_TTL_MS : OPEN_TTL_MS;
  if (r.pr.status === "closed") return CLOSED_TTL_MS;
  return Infinity;
}

const cache = new Map<string, { reading: SessionPrReading; at: number }>();
const inflight = new Map<string, Promise<SessionPrReading>>();
const lastSeen = new Map<string, number>();

const linkKey = (workspace: string, link: Pick<SessionPrLink, "host" | "repo" | "number">) => `pr:${workspace}\n${prRefKey(link)}`;
const branchKey = (workspace: string, branch: string) => `branch:${workspace}\n${branch}`;

function load(workspace: string, link: SessionPrLink | null, branch: string | undefined, force: boolean, reason: Reason): Promise<SessionPrReading> {
  const key = link ? linkKey(workspace, link) : branchKey(workspace, branch ?? "");
  const hit = cache.get(key);
  // A merged PR stays merged: not even a turn ending asks for it again.
  const final = hit?.reading.pr?.status === "merged";
  if (hit && (final || (!force && Date.now() - hit.at < ttlFor(hit.reading, reason)))) {
    return Promise.resolve(link ? { ...hit.reading, link } : hit.reading);
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = readPrLink(workspace, link, branch)
    .then((reading) => {
      cache.set(key, { reading, at: Date.now() });
      return reading;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Every PR of the session, through the shared cache (auto-archive reads them this way too). */
export function readSessionPrs(s: PrSession, force = false, reason: Reason = "tick"): Promise<SessionPrReading[]> {
  const legacy = legacyPrBranch(s);
  return Promise.all([
    ...(s.prs ?? []).map((link) => load(s.workspace, link, undefined, force, reason)),
    ...(legacy ? [load(s.workspace, null, legacy, force, reason)] : []),
  ]);
}

/** What Recents shows for a session: its most relevant PR, or a linked PR gh couldn't read. */
export type SessionPrBadge =
  | (SessionPr & { problem?: undefined })
  | { status: "unknown"; number: number; url: string; problem: GhProblem | null; createdAt?: undefined };

/** The PR to show out of a session's readings: its most relevant own PR (open, draft, merged,
 *  closed; newest first), else the newest link gh couldn't read, so the PR doesn't vanish. */
export function pickSessionBadge(s: Pick<SessionSummary, "createdAt" | "prPushed">, readings: SessionPrReading[]): SessionPrBadge | null {
  const best = pickSessionPr(s, readings);
  if (best) return { status: best.status, number: best.number, url: best.url, createdAt: best.createdAt };
  const unread = newestUnreadLink(readings);
  return unread ? { status: "unknown", number: unread.link.number, url: unread.link.url, problem: unread.problem } : null;
}

/** What to tell the user when gh couldn't read a linked PR. */
export function ghProblemText(
  problem: GhProblem | null,
  t: { ghNoLogin: string; ghMissing: string; ghNoAccess: string; prStatusFailed: string },
): string {
  return problem === "auth" ? t.ghNoLogin : problem === "missing" ? t.ghMissing : problem === "noAccess" ? t.ghNoAccess : t.prStatusFailed;
}

export function useSessionPrs(sessions: SessionSummary[]): Record<string, SessionPrBadge> {
  const [prs, setPrs] = useState<Record<string, SessionPrBadge>>({});
  const targets = JSON.stringify(
    sessions
      .filter((s): s is SessionSummary & { workspace: string } => !!s.workspace && hasPrLinks(s))
      .map((s) => ({
        id: s.id,
        workspace: s.workspace,
        createdAt: s.createdAt,
        modifiedAt: s.modifiedAt,
        prPushed: !!s.prPushed,
        prBranch: s.prBranch,
        prs: s.prs,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

  useEffect(() => {
    const list = JSON.parse(targets) as Array<PrSession & { modifiedAt: number }>;
    let alive = true;
    const refresh = async (reason: Reason) => {
      const results = await Promise.all(
        list.map(async (t) => {
          // The session did something (a turn ended): it may have pushed, opened or merged.
          const changed = lastSeen.has(t.id) && lastSeen.get(t.id) !== t.modifiedAt;
          lastSeen.set(t.id, t.modifiedAt);
          return [t.id, pickSessionBadge(t, await readSessionPrs(t, changed, reason))] as const;
        }),
      );
      if (!alive) return;
      const next: Record<string, SessionPrBadge> = {};
      for (const [id, pr] of results) if (pr) next[id] = pr;
      setPrs((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    void refresh("tick");
    // Nobody sees the badges while the window is hidden; the focus refresh catches up.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh("tick");
    }, TICK_MS);
    const onFocus = () => void refresh("focus");
    window.addEventListener("focus", onFocus);
    // A PR was just linked: a cached reading of it (or "no PR yet" on its branch) is stale.
    const offLinked = onPrLinked(({ ref, branch }) => {
      for (const t of list) {
        if (ref) cache.delete(linkKey(t.workspace, ref));
        if (branch) cache.delete(branchKey(t.workspace, branch));
      }
      void refresh("tick");
    });
    // The Git bar read a PR, or the agent merged it: take it as is, no need to ask.
    const offChanged = onPrChanged(({ branch, pr }) => {
      const ref = pr?.url ? parsePrUrl(pr.url) : null;
      let hit = false;
      for (const t of list) {
        const keys: string[] = [];
        if (legacyPrBranch(t) === branch) keys.push(branchKey(t.workspace, branch));
        for (const link of t.prs ?? []) {
          const same = ref ? prRefKey(ref) === prRefKey(link) : link.branch === branch;
          if (same) keys.push(linkKey(t.workspace, link));
        }
        for (const key of keys) {
          hit = true;
          const prev = cache.get(key)?.reading;
          if (pr === undefined || pr === null || !prev) cache.delete(key);
          else if (prev.pr) cache.set(key, { reading: { ...prev, pr: { ...prev.pr, ...pr }, problem: null }, at: Date.now() });
          else cache.delete(key);
        }
      }
      if (hit) void refresh("tick");
    });
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      offLinked();
      offChanged();
    };
  }, [targets]);

  return prs;
}
