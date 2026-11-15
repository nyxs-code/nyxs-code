import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ArrowRight, Check, ChevronDown, CircleDashed, GitPullRequest, Loader2, Minus, MoreVertical, X } from "lucide-react";
import { VISUAL_PROMPT_EVENT } from "@/lib/visualBridge";
import { ciFixAlreadyAsked, ciFixKey, noteCiFixAsked, setPrAutoFix, usePrAutoFix } from "@/lib/prAutoFix";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n";
import { subscribeFsChange, subscribeGitChange } from "@/lib/fsWatch";
import { runGit } from "@/lib/gitErrors";
import {
  fetchBranchPrDetails,
  isMergedPrLink,
  notifyPrChanged,
  onPrChanged,
  onPrLinked,
  pickBarPr,
  prLookup,
  readPrLink,
  setPrAutoMerge,
  type BranchPrDetails,
  type GhProblem,
  type SessionPrReading,
} from "@/lib/prArchive";
import { sessionPrState } from "@/lib/sessionStorage";
import { parsePrUrl, prRefKey, type SessionPrLink } from "@/lib/sessionPrLinks";
import { ghProblemText } from "@/lib/sessionPrs";
import { addMergedPrCard, dismissMergedPrCards, useMergedPrCards } from "@/lib/mergedPrCards";
import { MergedPrCards } from "@/components/MergedPrCards";
import { openExternalUrl } from "@/lib/openExternal";
import { GitPushButton } from "@/components/GitPushButton";
import { DIFF_FLAGS, PLAIN_PATHS, resolveDiffBase, useDiffMode, type DiffMode } from "@/lib/gitBase";

const MAX_UNTRACKED_COUNTED = 50;
const POLL_MS = 15_000;
const CI_POLL_MS = 15_000;
/** An open PR gets merged or closed on GitHub, often by someone else: its card and Recents'
 *  icon should follow within seconds. */
const PR_POLL_MS = 15_000;
/** A PR that was just opened: GitHub takes a few seconds to register its checks. */
const FRESH_PR_POLL_MS = 10_000;
const FRESH_PR_MS = 10 * 60_000;
/** A pushed branch without a PR yet: one can be opened anywhere (GitHub's site, a terminal, a
 *  teammate), with nothing in the app to say so. */
const NO_PR_POLL_MS = 30_000;

interface GitState {
  branch: string;
  defaultBranch: string | null;
  added: number;
  removed: number;
  dirty: boolean;
  /** Commits on HEAD that the default branch doesn't have. */
  ahead: number;
  /** The commit origin has for the branch ("" when it was never pushed): a push changes it. */
  pushed: string;
}

const git = (cwd: string, args: string[]) => runGit(cwd, ["--no-optional-locks", ...args], 15_000);

function sumNumstat(raw: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of raw.split("\n")) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed };
}

/** The branch and what it changes, in the folder's diff mode (see gitBase): against the
 *  merge-base with the default branch, so uncommitted edits, the branch's commits and new files
 *  all count, or only what isn't committed. The changes panel counts the same way. */
async function loadGitState(cwd: string, mode: DiffMode): Promise<GitState | null> {
  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch = head.stdout.trim();
  const hasHead = head.code === 0;
  if (!hasHead) {
    const sym = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
    if (sym.code !== 0) return null;
    branch = sym.stdout.trim();
  }
  const { base: diffBase, baseRef } = await resolveDiffBase(cwd, mode, hasHead);
  // A PR needs a remote: commits ahead of a local main (a repo without origin) don't offer one.
  const remoteBase = baseRef?.startsWith("origin/") ? baseRef : null;

  // Pending edits by content, not `git status`: that one also lists files that were only touched
  // or only had their line endings converted, and the bar would offer a PR for nothing.
  const [numstat, pending, untracked, ahead, pushed] = await Promise.all([
    git(cwd, [...PLAIN_PATHS, "diff", "--numstat", ...DIFF_FLAGS, diffBase]),
    hasHead ? git(cwd, ["diff", "--quiet", "--ignore-cr-at-eol", "HEAD"]) : git(cwd, ["status", "--porcelain"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    remoteBase ? git(cwd, ["rev-list", "--count", `${remoteBase}..HEAD`]) : null,
    hasHead ? pushedCommit(cwd, branch) : null,
  ]);
  const totals = sumNumstat(numstat.stdout);
  const newFiles = untracked.code === 0 ? untracked.stdout.split("\0").filter(Boolean) : [];
  const newStats = await Promise.all(
    newFiles.slice(0, MAX_UNTRACKED_COUNTED).map((p) =>
      git(cwd, [...PLAIN_PATHS, "diff", "--no-index", "--numstat", "--", "/dev/null", p]).catch(() => null),
    ),
  );
  for (const s of newStats) if (s) totals.added += sumNumstat(s.stdout).added;

  return {
    branch,
    defaultBranch: baseRef ? baseRef.replace(/^origin\//, "") : null,
    added: totals.added,
    removed: totals.removed,
    dirty: newFiles.length > 0 || (hasHead ? pending.code === 1 : pending.code === 0 && pending.stdout.trim() !== ""),
    ahead: ahead?.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0,
    pushed: pushed?.code === 0 ? pushed.stdout.trim() : "",
  };
}

/** What the branch's remote has, wherever it pushes to: `@{push}` follows a branch pushed under
 *  another name or to a fork; origin/<branch> covers a push that set no upstream. */
async function pushedCommit(cwd: string, branch: string) {
  const push = await git(cwd, ["rev-parse", "--verify", "--quiet", "@{push}"]);
  return push.code === 0 ? push : git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
}

/** The PR the bar shows: the checked-out branch's (`local`), or else one the session opened
 *  from another branch or worktree. */
type BarPr = BranchPrDetails & { local: boolean };

/** A PR the session linked that gh couldn't read (no login, no access): the bar still shows it,
 *  with why, instead of offering to create a PR. */
interface UnreadPr {
  number: number;
  url: string;
  problem: GhProblem | null;
}

/** What the session is linked to: its PRs, newest first, and an old-style branch link. */
interface SessionLinks {
  prs: SessionPrLink[];
  branch: string | null;
  /** When the session started, which tells an old-style branch link's own PR from an older one. */
  createdAt: number;
}

const NO_LINKS: SessionLinks = { prs: [], branch: null, createdAt: 0 };

async function readSessionLinks(workspace: string | null, sessionId: string): Promise<SessionLinks> {
  const st = await sessionPrState(workspace, sessionId);
  if (!st) return NO_LINKS;
  return {
    prs: [...st.prs].sort((a, b) => b.linkedAt - a.linkedAt),
    branch: st.legacyBranch && !isMergedPrLink(st.legacyBranch) ? st.legacyBranch : null,
    createdAt: st.createdAt,
  };
}

const isOpenPr = (pr: BranchPrDetails | null): boolean => pr?.status === "open" || pr?.status === "draft";

/** An open PR first (the checked-out branch's, then the session's newest); a merged one only
 *  when no open one is left, so its card can show. The session's PRs are read by URL, so they
 *  show even when the folder is on another branch and the PR's worktree is gone. */
async function findBarPr(cwd: string, state: GitState, links: SessionLinks): Promise<{ pr: BarPr | null; unread: UnreadPr | null }> {
  let own: BranchPrDetails | null = null;
  if (state.branch !== "HEAD") {
    const lookup = await prLookup(cwd, state.branch);
    // The default branch has no PR of its own, except in a fork, where it can be a PR's head.
    if (state.branch !== state.defaultBranch || lookup.fork) {
      own = await fetchBranchPrDetails(cwd, state.branch, lookup);
      if (own && isOpenPr(own)) return { pr: { ...own, local: true }, unread: null };
    }
  }
  // All of the session's PRs, read like Recents reads them; the checked-out branch's PR isn't
  // asked for twice.
  const ownRef = own?.url ? parsePrUrl(own.url) : null;
  const readings: SessionPrReading[] = await Promise.all([
    ...links.prs.map((link) =>
      ownRef && prRefKey(ownRef) === prRefKey(link) ? { link, pr: own, problem: null } : readPrLink(cwd, link),
    ),
    ...(links.branch
      ? [links.branch === state.branch ? { link: null, branch: links.branch, pr: own, problem: null } : readPrLink(cwd, null, links.branch)]
      : []),
  ]);
  const picked = pickBarPr(own, state.branch, { createdAt: links.createdAt, prPushed: true }, readings);
  return {
    pr: picked.pr ? { ...picked.pr, local: picked.local } : null,
    unread: picked.unread ? { number: picked.unread.link.number, url: picked.unread.link.url, problem: picked.unread.problem } : null,
  };
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** A row of the PR menu that turns something on or off, with a line saying what it does. */
function MenuToggle({ checked, busy = false, onClick, title, desc }: { checked: boolean; busy?: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-bg-200 disabled:opacity-60"
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {checked && <Check className="h-4 w-4 text-accent" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-text-100">{title}</span>
        <span className="block text-[11.5px] leading-snug text-text-400">{desc}</span>
      </span>
    </button>
  );
}

function useCloseOnOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, open, close]);
}

// Last state per folder, so switching chats doesn't flash an empty bar.
const lastState = new Map<string, GitState>();
const lastPr = new Map<string, { pr: BarPr | null; unread: UnreadPr | null }>();
/** The pushed commit when the branch's PR was last asked for. */
const lastPrPushed = new Map<string, string>();

export function GitBar({
  workspace,
  refreshKey = 0,
  disabled = false,
  onOpenChanges,
  onCreatePr,
  sessionId,
  sessionWorkspace,
}: {
  workspace: string | null;
  /** The chat's session and the folder it is saved under, to show the PR it opened even when
   *  the folder is checked out on another branch. */
  sessionId?: string;
  sessionWorkspace?: string | null;
  refreshKey?: number;
  /** While the agent is working: the actions would only queue behind it. */
  disabled?: boolean;
  onOpenChanges: () => void;
  /** Commits whatever is pending, pushes the branch and opens the PR (the /pr prompt). */
  onCreatePr: () => void;
}) {
  const t = useTranslations().gitBar;
  // Shared with the changes panel: the +N −M is what it opens.
  const [diffMode] = useDiffMode(workspace);
  const [state, setState] = useState<GitState | null>(() => (workspace ? lastState.get(workspace) ?? null : null));
  const [pr, setPr] = useState<BarPr | null>(null);
  const [unread, setUnread] = useState<UnreadPr | null>(null);
  const [ciOpen, setCiOpen] = useState(false);
  const ciRef = useRef<HTMLDivElement>(null);
  const running = useRef(false);
  const again = useRef(false);
  const againPr = useRef(false);
  /** The PRs this chat's session opened, wherever it opened them. The ref is what `load` reads;
   *  the state re-renders so polling starts. */
  const linked = useRef<SessionLinks>(NO_LINKS);
  const [hasLinks, setHasLinks] = useState(false);
  const linkTo = useCallback((links: SessionLinks) => {
    linked.current = links;
    setHasLinks(links.prs.length > 0 || !!links.branch);
  }, []);

  const load = useCallback(
    async (withPr: boolean) => {
      if (!workspace) return;
      if (running.current) { again.current = true; againPr.current ||= withPr; return; }
      running.current = true;
      try {
        let checkPr = withPr;
        do {
          checkPr ||= againPr.current;
          again.current = false;
          againPr.current = false;
          const next = await loadGitState(workspace, diffMode).catch(() => null);
          if (next) lastState.set(workspace, next);
          else lastState.delete(workspace);
          setState(next);
          const links = linked.current;
          const key = `${workspace}\n${next?.branch ?? ""}\n${links.branch ?? ""}\n${links.prs.map(prRefKey).join(",")}`;
          // A push (the agent's own included) is when a PR may have been opened for the branch.
          const pushedSince = !!next && lastPrPushed.has(key) && lastPrPushed.get(key) !== next.pushed;
          if (!next) { setPr(null); setUnread(null); }
          else if (checkPr || pushedSince || !lastPr.has(key)) {
            setPr(lastPr.get(key)?.pr ?? null);
            lastPrPushed.set(key, next.pushed);
            const { pr: found, unread: notRead } = await findBarPr(workspace, next, links);
            lastPr.set(key, { pr: found, unread: notRead });
            setPr(found);
            setUnread(notRead);
            // Recents shows this PR's icon too: hand it over rather than have it ask again.
            if (found) {
              notifyPrChanged({
                branch: found.head,
                source: "bar",
                pr: { status: found.status, number: found.number, url: found.url, createdAt: found.createdAt },
              });
            }
          } else {
            setPr(lastPr.get(key)?.pr ?? null);
            setUnread(lastPr.get(key)?.unread ?? null);
          }
          checkPr = false;
        } while (again.current);
      } finally {
        running.current = false;
      }
    },
    [workspace, diffMode],
  );

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => { if (alive) void load(true); });
    return () => { alive = false; };
  }, [load]);

  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    const id = setTimeout(() => void load(true), 400);
    return () => clearTimeout(id);
  }, [refreshKey, load]);

  useEffect(() => {
    if (!workspace) return;
    const onChange = () => void load(false);
    const onFocus = () => void load(true);
    const unsub = subscribeFsChange(workspace, onChange);
    const unsubGit = subscribeGitChange(workspace, onChange);
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => { if (document.visibilityState === "visible") onChange(); }, POLL_MS);
    const offLinked = onPrLinked((detail) => {
      if (sessionId && detail.sessionId === sessionId) {
        // The link is saved before the event fires: read the session's whole list back.
        void readSessionLinks(sessionWorkspace ?? workspace, sessionId).then((links) => {
          linkTo(links);
          onFocus();
        });
      } else onFocus();
    });
    // The agent merged a PR: if it is this bar's, its card shows now, not at the next poll.
    const offChanged = onPrChanged((detail) => { if (detail.source !== "bar") onFocus(); });
    return () => { unsub(); unsubGit(); offLinked(); offChanged(); window.removeEventListener("focus", onFocus); clearInterval(poll); };
  }, [workspace, sessionWorkspace, load, sessionId, linkTo]);

  // The PRs this session opened before (a reopened chat), from its saved links.
  useEffect(() => {
    let alive = true;
    // Another chat (or none) in the same bar: drop the previous session's links.
    const read = sessionId ? readSessionLinks(sessionWorkspace ?? workspace, sessionId) : Promise.resolve(NO_LINKS);
    void read.then((links) => {
      if (!alive) return;
      linkTo(links);
      if (links.prs.length || links.branch) void load(true);
    });
    return () => { alive = false; };
  }, [sessionId, sessionWorkspace, workspace, load, linkTo]);

  // An open PR changes on GitHub too (checks re-run, merged, closed): ask again now and then,
  // more often while checks are running or have yet to show up on a new PR. A pushed branch
  // without one is asked too, since a PR can be opened from anywhere.
  const prIsOpen = pr?.status === "open" || pr?.status === "draft";
  const mayGetPr = !!state && (state.pushed !== "" || hasLinks);
  const prCi = prIsOpen ? pr.ci : null;
  const prCreatedAt = prIsOpen ? pr.createdAt : undefined;
  useEffect(() => {
    const fresh = prIsOpen && !prCi && !!prCreatedAt && Date.now() - prCreatedAt < FRESH_PR_MS;
    const ms = prIsOpen
      ? fresh ? FRESH_PR_POLL_MS : (prCi?.pending ?? 0) > 0 ? CI_POLL_MS : PR_POLL_MS
      : mayGetPr ? NO_PR_POLL_MS : 0;
    if (!ms) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(true); }, ms);
    return () => clearInterval(id);
  }, [prIsOpen, prCi, prCreatedAt, mayGetPr, load]);

  const closeCi = useCallback(() => setCiOpen(false), []);
  useCloseOnOutside(ciRef, ciOpen, closeCi);

  // The PR's ⋮ menu: "Merge when ready" and auto-fix for this PR, like Claude Code Desktop.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useCloseOnOutside(menuRef, menuOpen, closeMenu);
  const [merging, setMerging] = useState(false);
  const [mergeNote, setMergeNote] = useState("");
  // Auto-fix is kept per PR branch: the checked-out one, or the other branch the session's PR is on.
  const branch = pr && !pr.local ? pr.head : state?.branch ?? null;
  const autoFix = usePrAutoFix(workspace, branch);
  const toggleAutoMerge = async () => {
    if (!workspace || !branch || !pr || merging) return;
    setMerging(true);
    setMergeNote("");
    const res = await setPrAutoMerge(workspace, pr.url || String(pr.number), !pr.autoMerge);
    setMerging(false);
    if (res.ok) {
      if (res.merged) setMergeNote(t.mergedNow);
      void load(true);
    } else setMergeNote(res.reason === "notAllowed" ? t.autoMergeNotAllowed : t.autoMergeFailed.replace("{message}", res.message || "gh"));
  };

  // Auto-fix: once checks have finished with failures, the agent is asked to fix them, once per
  // pushed commit (a new push that fails again asks again), and only in the chat of the session
  // that opened the PR: the prompt goes to the chat on screen.
  useEffect(() => {
    if (!pr) return;
    const key = ciFixKey({ workspace, sessionId, autoFix, pr, linked: linked.current });
    if (!key || ciFixAlreadyAsked(key)) return;
    noteCiFixAsked(key);
    window.dispatchEvent(new CustomEvent<string>(VISUAL_PROMPT_EVENT, { detail: t.ciFixPrompt.replace(/\{n\}/g, String(pr.number)) }));
  }, [workspace, sessionId, autoFix, pr, hasLinks, t]);

  // The bar's PR got merged (here, on GitHub or by a teammate): its purple card. PRs the agent
  // merged itself are added by the turn (assistantTurn).
  const cardScope = sessionId ?? workspace;
  const mergedCards = useMergedPrCards(cardScope);
  const mergedPr = pr?.status === "merged" ? pr : null;
  useEffect(() => {
    if (!cardScope || !mergedPr?.url || !mergedPr.mergedAt) return;
    addMergedPrCard(cardScope, { url: mergedPr.url, number: mergedPr.number, base: mergedPr.base, mergedAt: mergedPr.mergedAt });
  }, [cardScope, mergedPr]);
  const cards = (
    <MergedPrCards cards={mergedCards} onDismiss={(urls) => { if (cardScope) dismissMergedPrCards(cardScope, urls); }} />
  );

  if (!workspace || !state) return cards;
  const prOpen = pr && (pr.status === "open" || pr.status === "draft") ? pr : null;
  const hasChanges = state.added > 0 || state.removed > 0;
  // A PR the session opened that gh can't read right now: shown with why, not "Create PR".
  const unreadPr = prOpen ? null : unread;
  if (!hasChanges && !state.dirty && !prOpen && !unreadPr) return cards;

  const canCreatePr = !prOpen && !unreadPr && state.branch !== "HEAD" && (state.dirty || state.ahead > 0);
  const btn = "h-7 px-2.5 border border-bg-300 bg-bg-100 text-[13px] text-text-200 hover:bg-bg-000 hover:text-text-100 transition-colors disabled:opacity-50 disabled:pointer-events-none";
  const ci = prOpen?.ci ?? null;
  const ciRows = ci
    ? [
        { key: "pending", label: t.ciInProgress, n: ci.pending, icon: <CircleDashed className="h-4 w-4 text-text-400" /> },
        { key: "passed", label: t.ciPassed, n: ci.passed, icon: <Check className="h-4 w-4 text-green-600 dark:text-green-400" /> },
        { key: "failed", label: t.ciFailed, n: ci.failed, icon: <X className="h-4 w-4 text-red-500 dark:text-red-400" /> },
        { key: "skipped", label: t.ciSkipped, n: ci.skipped, icon: <Minus className="h-4 w-4 text-text-400" /> },
      ]
    : [];

  return (
    <>
    {cards}
    <div className="relative z-0 mx-2 md:mx-0 mb-2 flex items-center gap-1.5 rounded-[8px] bg-bg-200 py-1.5 pl-3.5 pr-1.5 text-[13px]">
      {prOpen ? (
        <span className="flex min-w-0 items-center gap-1.5 text-text-200">
          <GitPullRequest className={cn("h-4 w-4 shrink-0", prOpen.status === "draft" ? "text-text-400" : "text-green-600 dark:text-green-400")} />
          <span className="shrink-0">{prOpen.base || state.defaultBranch || "main"}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-text-400" />
          <span className="truncate">{prOpen.head || state.branch}</span>
        </span>
      ) : unreadPr ? (
        <span className="flex min-w-0 items-center gap-1.5 text-text-200">
          <GitPullRequest className="h-4 w-4 shrink-0 text-text-400" />
          <span className="shrink-0">#{unreadPr.number}</span>
          <span className="truncate text-text-400">{ghProblemText(unreadPr.problem, t)}</span>
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-3 text-text-400">
          <span className="truncate">{baseName(workspace)}</span>
          <span className="truncate">{state.branch}</span>
        </span>
      )}
      <span className="flex-1" />
      {hasChanges && (
        <button
          type="button"
          onClick={onOpenChanges}
          aria-label={t.viewChanges}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border border-bg-300 bg-bg-100 px-2 text-[13px] tabular-nums transition-colors hover:bg-bg-000"
        >
          <span className="text-green-600 dark:text-green-400">+{state.added}</span>
          <span className="text-red-500 dark:text-red-400">-{state.removed}</span>
        </button>
      )}
      {ci && prOpen && (
        <div ref={ciRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setCiOpen((o) => !o)}
            aria-expanded={ciOpen}
            className={cn(btn, "flex items-center gap-1 rounded-[6px] px-2", ciOpen && "bg-bg-000 text-text-100")}
          >
            {ci.failed > 0 ? (
              <X className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />
            ) : ci.pending > 0 ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-text-400" />
            ) : (
              <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            )}
            {t.ci}
            <ChevronDown className="h-3.5 w-3.5 text-text-400" />
          </button>
          {ciOpen && (
            <div data-mod-menu role="menu" className="absolute bottom-full right-0 z-30 mb-1 w-56 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg">
              <p className="px-2 pt-1 pb-1.5 text-[12px] text-text-400">{t.ciMonitoring}</p>
              {ciRows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  role="menuitem"
                  onClick={() => { setCiOpen(false); if (prOpen.url) openExternalUrl(`${prOpen.url}/checks`); }}
                  className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-text-200 hover:bg-bg-200"
                >
                  {r.icon}
                  <span className="flex-1">{r.label}</span>
                  <span className="tabular-nums text-text-400">{r.n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {prOpen ? (
        <>
          {/* Pushing sends the checked-out branch, which isn't the PR's when it was opened elsewhere. */}
          {prOpen.local && (
            <GitPushButton workspace={workspace} branch={state.branch} version={state} disabled={disabled} className={btn} onPushed={() => void load(true)} />
          )}
          <button type="button" onClick={() => prOpen.url && openExternalUrl(prOpen.url)} className={cn(btn, "shrink-0 rounded-[6px]")}>
            {t.viewPr}
          </button>
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => { setMenuOpen((o) => !o); setMergeNote(""); }}
              aria-label={t.prActions}
              aria-expanded={menuOpen}
              className={cn(btn, "flex w-7 items-center justify-center rounded-[6px] px-0", menuOpen && "bg-bg-000 text-text-100")}
            >
              {merging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
            </button>
            {menuOpen && (
              <div data-mod-menu role="menu" className="absolute bottom-full right-0 z-30 mb-1 w-72 rounded-[8px] border border-bg-300 bg-bg-100 p-1 shadow-lg">
                <MenuToggle checked={prOpen.autoMerge} busy={merging} onClick={() => void toggleAutoMerge()} title={t.mergeWhenReady} desc={t.mergeWhenReadyDesc} />
                <MenuToggle
                  checked={autoFix}
                  onClick={() => workspace && branch && setPrAutoFix(workspace, branch, !autoFix)}
                  title={t.autoFixPr}
                  desc={t.autoFixPrDesc}
                />
                {mergeNote && <p className="px-2 pb-1.5 pt-1 text-[12px] text-text-300">{mergeNote}</p>}
              </div>
            )}
          </div>
        </>
      ) : unreadPr ? (
        <button type="button" onClick={() => openExternalUrl(unreadPr.url)} className={cn(btn, "shrink-0 rounded-[6px]")}>
          {t.viewPr}
        </button>
      ) : canCreatePr ? (
        <button type="button" onClick={onCreatePr} disabled={disabled} className={cn(btn, "shrink-0 rounded-[6px]")}>
          {t.createPr}
        </button>
      ) : null}
    </div>
    </>
  );
}
