import { useEffect, useRef, useState, type DragEvent } from "react";
import { useCloseOnBlur } from "@/lib/useCloseOnBlur";
import { createPortal } from "react-dom";
import { Plus, Search, Settings, Code2, Clock, Plug, Copy, ChevronDown, ChevronRight, Check, Languages, LifeBuoy, History, LogOut, EllipsisVertical, MessageSquareHeart, GitPullRequest, GitPullRequestDraft, GitPullRequestClosed, GitMerge, Folder, FolderOpen, Layers, Pin, Pencil, Trash2, X } from "lucide-react";
import { LearnMoreMenu } from "@/components/sidebar/LearnMoreMenu";
import { NavRows } from "@/components/sidebar/NavRows";
import { ProjectsList } from "@/components/sidebar/ProjectsList";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { SessionMenu, type SessionCopy, type SessionMenuAction, type SessionMenuTarget } from "@/components/sidebar/SessionMenu";
import { createSection, deleteSection, moveToSection, renameSection, setPinned, setUnread, useSessionMarks } from "@/lib/sessionMarks";
import { shortAge } from "@/lib/time";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "@/lib/sidebarWidth";
import { ghProblemText, useSessionPrs, type SessionPrBadge } from "@/lib/sessionPrs";
import { setSessionOrder } from "@/lib/sessionOrder";
import type { PrStatus } from "@/lib/prArchive";
import type { SessionSummary } from "@/lib/sessionStorage";
import { SESSION_STATE_META, type SessionState } from "@/lib/sessionState";
import { RecentsFilterMenu } from "@/components/RecentsFilterMenu";
import { buildRecentsGroups, recentsProjects, isRecentsFilterActive, DEFAULT_RECENTS_FILTER, type RecentsFilter } from "@/lib/recentsFilter";
import { workspaceName } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { accountKey } from "@/lib/accountScope";
import { LANGUAGES, LANG_KEY, useTranslations, setLanguage as persistLanguage } from "@/lib/i18n";
import { shortFileList } from "@/lib/archiveGuard";
import { updateSettingsForSource } from "@/lib/settingsRuntime";
import { UpdateAlert } from "@/components/UpdateAlert";
import { ChangelogModal } from "@/components/ChangelogModal";
import { getSession, signOut, userInitials, AUTH_CHANGED_EVENT, type AuthUser } from "@/lib/auth";
import { FeedbackModal } from "@/components/FeedbackModal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BrailleSpinner } from "@/components/ui/braille-spinner";
import { TextShimmer } from "@/components/ui/text-shimmer";
import type { Section } from "@/lib/sections";
import { useNow } from "@/lib/useNow";
import { stripKeyChars } from "@/lib/macKeyGuard";
import { deleteTargetOf, nestSessions } from "@/lib/sessionTree";
import { SESSION_DRAG_TYPE } from "@/lib/useSplitView";
import { isComposingKey } from "@/lib/imeKeys";
import { useShortcutLabel } from "@/lib/keyBindings";

/** How far each level of nested sessions is indented, in px. */
const NEST_INDENT = 14;

/**
 * Full title to the right of a Recents row, only when the title is cut off: past its box or
 * under the row's hover menu button. Hidden while the row's menu is open.
 */
function titleTooltip(title: string | undefined, menuOpen: boolean) {
  if (!title || menuOpen) return {};
  return { "data-tooltip": title, "data-tooltip-side": "right", "data-tooltip-clipped": "" };
}

export interface ChatSummary {
  id: string;
  title: string;
}

function MenuItem({
  icon: Icon,
  label,
  shortcut,
  arrow,
  onClick,
  close,
}: {
  icon: typeof Code2;
  label: string;
  shortcut?: string;
  arrow?: boolean;
  onClick?: () => void;
  close: () => void;
}) {
  return (
    <button
      onClick={() => { onClick?.(); close(); }}
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
    >
      <Icon className="w-4 h-4 text-text-300 shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-[11px] text-text-500">{shortcut}</span>}
      {arrow && <ChevronRight className="w-3.5 h-3.5 text-text-400" />}
    </button>
  );
}

const PR_META: Record<PrStatus | "unknown", { icon: typeof GitPullRequest; cls: string }> = {
  unknown: { icon: GitPullRequest, cls: "text-text-500" },
  open: { icon: GitPullRequest, cls: "text-green-600 dark:text-green-500" },
  draft: { icon: GitPullRequestDraft, cls: "text-text-400" },
  merged: { icon: GitMerge, cls: "text-purple-600 dark:text-purple-400" },
  closed: { icon: GitPullRequestClosed, cls: "text-red-600 dark:text-red-500" },
};

function ChatStatus({
  working,
  needsAttention,
  attentionLabel,
  idleLabel,
  pr,
  prLabel,
  prProblem,
  unread,
  unreadLabel,
  selected,
}: {
  working: boolean;
  needsAttention: boolean;
  attentionLabel: string;
  idleLabel: string;
  pr?: SessionPrBadge;
  prLabel?: string;
  /** Why the PR's status is unknown (gh without a login…), shown on hover. */
  prProblem?: string;
  /** Marked unread by the user: an accent dot until it is opened. */
  unread?: boolean;
  unreadLabel?: string;
  /** In selection mode, the row's checkbox instead of its status; undefined outside it. */
  selected?: boolean;
}) {
  const prMeta = pr ? PR_META[pr.status] : null;
  if (selected !== undefined) {
    return (
      <span className="w-4 flex items-center justify-center shrink-0">
        <span className={cn("w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center", selected ? "bg-accent border-accent" : "border-text-500")}>
          {selected && <Check className="w-3 h-3 text-bg-0" strokeWidth={3} />}
        </span>
      </span>
    );
  }
  return (
    <span className="w-4 flex items-center justify-center shrink-0">
      {needsAttention ? (
        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" data-tooltip={attentionLabel} />
      ) : working ? (
        <BrailleSpinner className="text-text-200" />
      ) : unread ? (
        <span className="w-2 h-2 rounded-full bg-accent" aria-label={unreadLabel} />
      ) : pr && prMeta ? (
        <prMeta.icon
          className={cn("w-3.5 h-3.5", prMeta.cls)}
          aria-label={prProblem ? `${prLabel} #${pr.number}: ${prProblem}` : `${prLabel} #${pr.number}`}
          data-tooltip={prProblem ? `#${pr.number} · ${prProblem}` : undefined}
        />
      ) : (
        <span className="w-1.5 h-1.5 rounded-full bg-text-500" data-tooltip={idleLabel} />
      )}
    </span>
  );
}

/** Claude's plugins icon: a plug lying at 45°, its prongs up and to the right. */
function PluginsIcon({ className }: { className?: string }) {
  return <Plug className={cn(className, "rotate-45")} />;
}

/** Claude's artifacts icon: two overlapping cards, the front one at the bottom left. */
function ArtifactsIcon({ className }: { className?: string }) {
  return <Copy className={cn(className, "-scale-x-100")} />;
}

const OPTIONAL_ITEMS: {
  id: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  section: Section;
  badge?: string;
}[] = [
  { id: "projects", label: "Projects", icon: ProjectIcon, section: "projects", badge: "Beta" },
  { id: "routines", label: "Scheduled", icon: Clock, section: "routines" },
  { id: "artifacts", label: "Artifacts", icon: ArtifactsIcon, section: "artifacts" },
  { id: "customize", label: "Plugins", icon: PluginsIcon, section: "customize" },
];

interface SidebarProps {
  chats: ChatSummary[];
  activeChatId: string | null;
  streamingChatIds?: Set<string>;
  awaitingPermissionChatIds?: Set<string>;
  awaitingQuestionChatIds?: Set<string>;
  section: Section;
  onSectionChange: (s: Section) => void;
  onNewChat: () => void;
  onOpenSearch?: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onOpenSettings: () => void;
  sessions?: SessionSummary[];
  archivedSessions?: SessionSummary[];
  sessionStates?: Record<string, SessionState>;
  onSelectSession?: (id: string) => void;
  /** `withNested` also deletes the sessions nested under it; otherwise they move up a level. */
  onDeleteSession?: (id: string, withNested?: boolean) => void;
  onRenameSession?: (id: string, title: string) => void;
  onRewindSession?: (id: string) => void;
  onArchiveSession?: (id: string) => void;
  /** Several sessions at once, from selection mode: one after the other. */
  onArchiveSessions?: (ids: string[]) => void;
  onDeleteSessions?: (ids: string[]) => void;
  /** Split view: shows the session next to the open one. Unset hides "Open to the side" and
   *  dragging rows onto the chat. */
  onOpenToSide?: (id: string) => void;
  /** Opens the session with its side chat. */
  onNewSideChat?: (id: string) => void;
  /** A copy of the whole session, opened. */
  onForkSession?: (id: string) => void;
  /** The Routines form, filled in from the session. */
  onScheduleSession?: (id: string) => void;
  /** Asks the session's agent to write a skill from what it did there. */
  onSkillFromSession?: (id: string) => void;
  onCopySession?: (id: string, what: SessionCopy) => void;
  onMoveSession?: (id: string, workspace: string) => void;
  /** Files the session changed that aren't committed, named in the delete confirmation. */
  uncommittedFilesOf?: (id: string) => Promise<string[]>;
  /** The sessions have been listed once; until then an empty project says nothing. */
  sessionsLoaded?: boolean;
  onOpenArchived?: () => void;
  onOpenHelp?: () => void;
  archivedCount?: number;
  /** The project folders the user works in, listed even before they have a session. */
  projects?: string[];
  /** The folder the app is working in right now, marked in the list. */
  currentWorkspace?: string | null;
  onNewSessionIn?: (workspace: string) => void;
  onOpenFolder?: (workspace: string) => void;
  onRemoveProject?: (workspace: string) => void;
  /** Opens a project (Proyectos): its coordinator conversation. */
  onOpenProject?: (projectId: string) => void;
  /** The project the open session belongs to, marked in the Proyectos list. */
  activeProjectId?: string;
}

// The sidebar's width, dragged from its right edge and remembered per account.
const SIDEBAR_WIDTH_KEY = "nyxs.sidebarWidth";
const clampWidth = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
function loadSidebarWidth(): number {
  const v = Number.parseInt(localStorage.getItem(accountKey(SIDEBAR_WIDTH_KEY)) ?? "", 10);
  return Number.isNaN(v) ? SIDEBAR_DEFAULT : clampWidth(v);
}

/** The handle on the sidebar's right edge: drag to resize, double-click for the default width.
 *  Its tooltip follows the cursor along the edge, as in the firm's other app. */
function SidebarResizeHandle({
  width,
  onResize,
  hint,
  dragHint,
  label,
}: {
  width: number;
  onResize: (w: number) => void;
  hint: string;
  dragHint: string;
  label: string;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const keys = useShortcutLabel("toggleSidebar");
  const [dragging, setDragging] = useState(false);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setTip(null);
    setDragging(true);
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => onResize(clampWidth(startW + ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setDragging(false);
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        onMouseDown={startResize}
        onDoubleClick={() => onResize(SIDEBAR_DEFAULT)}
        onMouseMove={(e) => {
          if (dragging) return;
          setTip({ x: e.currentTarget.getBoundingClientRect().right + 16, y: e.clientY });
        }}
        onMouseLeave={() => setTip(null)}
        className="absolute top-0 -right-1.5 z-20 h-full w-2 cursor-col-resize"
      />
      {/* While dragging, the cursor can cross the chat and the browser panel: this keeps the
          resize cursor and the mouse events with the drag. */}
      {dragging && <div data-drag-shield className="fixed inset-0 z-[60] cursor-col-resize" />}
      {tip &&
        createPortal(
          <span
            data-webview-hole
            className="app-tooltip pointer-events-none fixed z-[9999] flex -translate-y-1/2 flex-col gap-0.5 whitespace-nowrap px-2.5 py-1.5 text-left text-[11px] leading-snug shadow-xl"
            style={{ left: tip.x, top: tip.y }}
          >
            <span className="inline-flex items-center gap-2">
              <span className="font-semibold">{hint}</span>
              {keys && <span className="app-tooltip-muted">{keys}</span>}
            </span>
            <span className="app-tooltip-muted">{dragHint}</span>
          </span>,
          document.body,
        )}
    </>
  );
}

const COLLAPSED_KEY = "nyxs.recentsCollapsed.v1";
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(accountKey(COLLAPSED_KEY)) || "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function Sidebar({
  chats,
  activeChatId,
  streamingChatIds,
  awaitingPermissionChatIds,
  awaitingQuestionChatIds,
  section,
  onSectionChange,
  onNewChat,
  onOpenSearch,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
  onOpenSettings,
  sessions = [],
  archivedSessions = [],
  sessionStates,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onRewindSession,
  onArchiveSession,
  onArchiveSessions,
  onDeleteSessions,
  onOpenToSide,
  onNewSideChat,
  onForkSession,
  onScheduleSession,
  onSkillFromSession,
  onCopySession,
  onMoveSession,
  uncommittedFilesOf,
  sessionsLoaded = true,
  onOpenArchived,
  onOpenHelp,
  archivedCount = 0,
  projects = [],
  currentWorkspace,
  onNewSessionIn,
  onOpenFolder,
  onRemoveProject,
  onOpenProject,
  activeProjectId,
}: SidebarProps) {
  const inCode =
    section === "code" || section === "projects" || section === "routines" || section === "artifacts" || section === "customize" || section === "feedback";

  const t = useTranslations().sidebar;
  const tm = useTranslations().sidebarMenu;
  const tProjects = useTranslations().projects;
  // A row dragged onto the chat area opens there next to the open session (see SessionDropZone).
  const dragToSide = (e: DragEvent, id: string) => {
    e.dataTransfer.setData(SESSION_DRAG_TYPE, id);
    e.dataTransfer.effectAllowed = "move";
  };
  const tSearch = useTranslations().search;
  const searchKeys = useShortcutLabel("searchSessions");
  const tTitle = useTranslations().titleBar;

  const [changelogOpen, setChangelogOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // `y` is just under the ⋮ button and `above` just over it, where the menu goes when it doesn't
  // fit below (the last sessions of the list).
  const [chatMenu, setChatMenu] = useState<{ id: string; x: number; y: number; above: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string; isSession: boolean; dirty?: string[]; nested: number } | null>(null);
  const tGuard = useTranslations().archiveGuard;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [recentsFilter, setRecentsFilter] = useState<RecentsFilter>(DEFAULT_RECENTS_FILTER);
  const now = useNow();
  const groupLabels = useTranslations().recentsGroups;
  const marks = useSessionMarks();
  const recentGroups = buildRecentsGroups(sessions, archivedSessions, recentsFilter, now, sessionStates, projects, groupLabels, marks);
  const recentProjects = recentsProjects([...sessions, ...archivedSessions]);
  const recentTotal = recentGroups.reduce((n, g) => n + g.items.length, 0);
  const byProject = recentsFilter.groupBy === "project";
  // Groups with a header that folds: projects, and the user's pinned sessions and sections.
  const foldable = (g: { kind?: string }) => byProject || !!g.kind;
  // An unread mark goes once the session is opened.
  useEffect(() => {
    if (activeChatId) setUnread(activeChatId, false);
  }, [activeChatId]);
  // Selection mode: the rows picked for a bulk action; null outside it.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const [pendingBulkDelete, setPendingBulkDelete] = useState<string[] | null>(null);
  // "New section…": the sessions it will hold and the name being typed.
  const [newSection, setNewSection] = useState<{ ids: string[]; name: string } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingSection, setRenamingSection] = useState<{ id: string; name: string } | null>(null);
  const sectionRenameCancelled = useRef(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      localStorage.setItem(accountKey(COLLAPSED_KEY), JSON.stringify([...next]));
      return next;
    });
  // Parents whose nested sessions are folded away.
  const [foldedParents, setFoldedParents] = useState<Set<string>>(() => new Set());
  const toggleNested = (id: string) =>
    setFoldedParents((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [projectMenu, setProjectMenu] = useState<{ workspace: string; x: number; y: number } | null>(null);
  useCloseOnBlur(!!chatMenu || !!projectMenu || !!sectionMenu, () => { setChatMenu(null); setProjectMenu(null); setSectionMenu(null); });
  const [width, setWidth] = useState<number>(loadSidebarWidth);
  useEffect(() => {
    try { localStorage.setItem(accountKey(SIDEBAR_WIDTH_KEY), String(width)); } catch { /* storage full: the width just isn't kept */ }
  }, [width]);
  const sessionPrs = useSessionPrs(recentGroups.flatMap((g) => g.items));
  // Ctrl+Tab walks Recents as shown: folded projects are skipped.
  const visibleOrder = recentGroups
    .filter((g) => !(foldable(g) && collapsed.has(g.key)))
    .flatMap((g) => g.items.map((s) => s.id))
    .join("\n");
  useEffect(() => setSessionOrder(visibleOrder ? visibleOrder.split("\n") : []), [visibleOrder]);
  const tGit = useTranslations().gitBar;
  const prLabels: Record<PrStatus | "unknown", string> = { unknown: t.prUnknown, open: t.prOpen, draft: t.prDraft, merged: t.prMerged, closed: t.prClosed };

  const startRename = (id: string) => {
    setRenamingId(id);
    setRenameValue(sessions.find((s) => s.id === id)?.title ?? chats.find((c) => c.id === id)?.title ?? "");
  };
  const commitRename = () => {
    const title = stripKeyChars(renameValue);
    if (renamingId && title.trim()) {
      if (sessions.some((s) => s.id === renamingId)) onRenameSession?.(renamingId, title);
      else onRenameChat(renamingId, title);
    }
    setRenamingId(null);
  };

  /** What the session menu needs to know of a row. */
  const menuTarget = (id: string): SessionMenuTarget => {
    const session = sessions.find((s) => s.id === id) ?? archivedSessions.find((s) => s.id === id);
    return {
      id,
      saved: !!session,
      isActive: id === activeChatId,
      working: streamingChatIds?.has(id) ?? false,
      hasMessages: (session?.messageCount ?? 0) > 0,
      workspace: session?.workspace ?? currentWorkspace ?? null,
      worktree: !!session?.worktree,
      pinned: marks.pinned.includes(id),
      unread: marks.unread.includes(id),
      sectionId: marks.sections.find((s) => s.ids.includes(id))?.id ?? null,
    };
  };

  const askDelete = (id: string) => {
    const target = deleteTargetOf(id, [...sessions, ...archivedSessions], chats);
    setPendingDelete(target);
    if (target.isSession && uncommittedFilesOf) {
      void uncommittedFilesOf(id).then((dirty) => {
        if (dirty.length) setPendingDelete((p) => (p?.id === id ? { ...p, dirty } : p));
      });
    }
  };

  const runMenuAction = (id: string, a: SessionMenuAction) => {
    if (typeof a === "object") {
      if ("copy" in a) onCopySession?.(id, a.copy);
      else if ("moveTo" in a) onMoveSession?.(id, a.moveTo);
      else moveToSection([id], a.section);
      return;
    }
    switch (a) {
      case "split": onOpenToSide?.(id); break;
      case "sideChat": onNewSideChat?.(id); break;
      case "fork": onForkSession?.(id); break;
      case "schedule": onScheduleSession?.(id); break;
      case "skill": onSkillFromSession?.(id); break;
      case "select": setSelected(new Set([id])); break;
      case "rename": startRename(id); break;
      case "rewind": onRewindSession?.(id); break;
      case "pin": setPinned(id, true); break;
      case "unpin": setPinned(id, false); break;
      case "markUnread": setUnread(id, true); break;
      case "markRead": setUnread(id, false); break;
      case "archive": onArchiveSession?.(id); break;
      case "delete": askDelete(id); break;
      case "newSection": setNewSection({ ids: [id], name: "" }); break;
    }
  };

  /** The row's menu at the pointer, on a right click. */
  const contextMenuAt = (e: React.MouseEvent, id: string) => {
    if (selected) return;
    e.preventDefault();
    setChatMenu({ id, x: e.clientX, y: e.clientY, above: e.clientY });
  };

  const [langOpen, setLangOpen] = useState(false);
  const [language, setLanguage] = useState<string>(() => localStorage.getItem(LANG_KEY) || "en-US");
  const accountRef = useRef<HTMLDivElement>(null);
  const langTimer = useRef<number | null>(null);

  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getSession().then((u) => { if (alive) setUser(u); });
    void load();
    window.addEventListener(AUTH_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(AUTH_CHANGED_EVENT, load);
    };
  }, []);

  const handleSignOut = async () => {
    await signOut();
    window.location.reload();
  };

  const openLang = () => {
    if (langTimer.current) window.clearTimeout(langTimer.current);
    setLangOpen(true);
  };
  const closeLang = () => {
    langTimer.current = window.setTimeout(() => setLangOpen(false), 200);
  };

  const selectLang = (code: string) => {
    setLanguage(code);
    persistLanguage(code as Parameters<typeof persistLanguage>[0]);
    void updateSettingsForSource("user", { language: code }).catch(() => {});
    setLangOpen(false);
    setAccountOpen(false);
  };

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <aside data-mod-panel className="relative shrink-0 flex flex-col bg-bg-0 border-r border-bg-300" style={{ width }}>
      {/* Only the stretch through the title bar (h-9) sits above it, so the divider runs the full
          height of the window without crossing the sidebar's own cards and menus. */}
      <div aria-hidden className="pointer-events-none absolute -right-px -top-9 h-9 z-[61] w-px bg-bg-300" />
      <SidebarResizeHandle width={width} onResize={setWidth} hint={t.toggleSidebarHint} dragHint={t.dragToResize} label={t.resizeSidebar} />
      {/* Chat / Code is switched from the title bar. */}
      <div className="pt-2" />

      {!inCode && <div className="flex-1" />}

      {inCode && (
      <>
      {/* Every row, nav and recents alike, shares one height, size and left edge. */}
      <div className="px-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2.5 px-2 py-1 rounded-[5px] text-sm leading-5 text-text-100 hover:bg-bg-200 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t.newSession}
        </button>
        {/* Search is a plain row like the others, as in Claude; the search itself opens in the
            sessions dialog. A right click moves a row to More. */}
        <NavRows
          rows={[
            ...(onOpenSearch ? [{ id: "search", icon: Search, label: tTitle.search, tooltip: tSearch.sessionsTitle, kbd: searchKeys, onClick: onOpenSearch, bright: true }] : []),
            ...OPTIONAL_ITEMS.map((it) => ({
              id: it.id,
              icon: it.icon,
              label: it.id === "projects" ? tProjects.navLabel : it.id === "routines" ? tm.routines : it.id === "artifacts" ? tm.artifacts : it.id === "customize" ? tm.customize : it.label,
              onClick: () => onSectionChange(it.section),
              active: section === it.section,
              badge: it.id === "projects" ? tProjects.beta : it.badge,
            })),
          ]}
        />
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pt-5 pb-3">
        {onOpenProject && <ProjectsList activeProjectId={activeProjectId} onOpen={onOpenProject} />}
        <div className="flex items-center justify-between px-2">
          <p className="text-[13px] text-text-400 truncate max-w-[160px]" data-tooltip={recentsFilter.project !== "all" ? recentsFilter.project : undefined}>
            {recentsFilter.project !== "all" ? workspaceName(recentsFilter.project) : t.recents}
          </p>
          <div className="flex items-center gap-1">
            {archivedCount > 0 && onOpenArchived && (
              <button
                type="button"
                onClick={onOpenArchived}
                className="text-[11px] font-medium text-text-500 hover:text-text-300 transition-colors"
                data-tooltip={tm.archivedTooltip}
              >
                {tm.archivedCount.replace("{count}", String(archivedCount))}
              </button>
            )}
            <RecentsFilterMenu value={recentsFilter} onChange={setRecentsFilter} projects={recentProjects} />
          </div>
        </div>

        {recentTotal > 0 || (byProject && recentGroups.length > 0) ? (
          recentGroups.map((group, gi) => {
            const folded = foldable(group) && collapsed.has(group.key);
            const current = byProject && !group.kind && !!group.workspace && group.workspace === currentWorkspace;
            const FolderIcon = folded ? Folder : FolderOpen;
            const sectionId = group.sectionId;
            const renamingThis = sectionId && renamingSection?.id === sectionId ? renamingSection : null;
            return (
            <div key={group.key} className={cn(foldable(group) && gi > 0 && "pt-1.5")}>
              {group.kind ? (
                <div className="group/project relative flex items-center">
                  {renamingThis ? (
                    <input
                      autoFocus
                      value={renamingThis.name}
                      onChange={(e) => setRenamingSection({ id: renamingThis.id, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isComposingKey(e)) e.currentTarget.blur();
                        if (e.key === "Escape") {
                          sectionRenameCancelled.current = true;
                          setRenamingSection(null);
                        }
                      }}
                      onBlur={() => {
                        // Escape already ended the rename; a blur after it keeps the old name.
                        if (!sectionRenameCancelled.current) renameSection(renamingThis.id, stripKeyChars(renamingThis.name));
                        sectionRenameCancelled.current = false;
                        setRenamingSection(null);
                      }}
                      className="w-full bg-bg-0 border border-accent rounded-[5px] px-2 py-[3px] text-[13px] leading-5 text-text-100 outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(group.key)}
                      aria-expanded={!folded}
                      className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-[5px] text-[13px] leading-5 text-left text-text-300 transition-colors hover:bg-bg-200"
                    >
                      {group.kind === "pinned" ? <Pin className="w-4 h-4 shrink-0 text-text-400" /> : <Layers className="w-4 h-4 shrink-0 text-text-400" />}
                      <span className="min-w-0 truncate">{group.label}</span>
                      <ChevronDown className={cn("w-3 h-3 shrink-0 text-text-500 transition-transform", folded && "-rotate-90")} />
                    </button>
                  )}
                  {sectionId && !renamingThis && (
                    <div
                      className={cn(
                        "absolute right-1 flex items-center transition-opacity",
                        sectionMenu?.id === sectionId ? "opacity-100" : "opacity-0 group-hover/project:opacity-100",
                      )}
                    >
                      <button
                        type="button"
                        aria-label={tm.sectionOptions}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setSectionMenu({ id: sectionId, x: r.left, y: r.bottom + 4 });
                        }}
                        className="p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
                      >
                        <EllipsisVertical className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ) : byProject ? (
                <div className="group/project relative flex items-center">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(group.key)}
                    aria-expanded={!folded}
                    className={cn(
                      "flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-[5px] text-[13px] leading-5 text-left transition-colors hover:bg-bg-200",
                      current ? "text-text-100 font-medium" : "text-text-300",
                    )}
                  >
                    <FolderIcon className={cn("w-4 h-4 shrink-0", current ? "text-accent" : "text-text-400")} />
                    <span className="min-w-0 truncate">{group.label}</span>
                    {current && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" data-tooltip={t.currentProject} />}
                  </button>
                  {group.workspace && (
                    <div
                      className={cn(
                        "absolute right-1 flex items-center gap-0.5 transition-opacity",
                        projectMenu?.workspace === group.workspace ? "opacity-100" : "opacity-0 group-hover/project:opacity-100",
                      )}
                    >
                      <button
                        type="button"
                        aria-label={t.projectOptions}
                        data-tooltip={t.projectOptions}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setProjectMenu({ workspace: group.workspace!, x: r.left, y: r.bottom + 4 });
                        }}
                        className="p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
                      >
                        <EllipsisVertical className="w-3.5 h-3.5" />
                      </button>
                      {onNewSessionIn && (
                        <button
                          type="button"
                          aria-label={t.newSessionHere}
                          data-tooltip={t.newSessionHere}
                          onClick={() => onNewSessionIn(group.workspace!)}
                          className="p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : group.label && (
                <p className="px-2 pt-3 pb-0.5 text-[13px] leading-5 text-text-500">{group.label}</p>
              )}
              {!folded && group.items.length === 0 && sessionsLoaded && (byProject || group.kind === "section") && (
                <p className="px-2 py-1 text-[13px] text-text-500">{group.kind === "section" ? tm.emptySection : t.noConversationsYet}</p>
              )}
              {!folded && nestSessions(group.items, foldedParents).map(({ item: session, depth, descendants, last }) => {
            const isActive = session.id === activeChatId;
            const menuOpen = chatMenu?.id === session.id;
            const working = streamingChatIds?.has(session.id) ?? false;
            const needsAttention =
              (awaitingPermissionChatIds?.has(session.id) ?? false) || (awaitingQuestionChatIds?.has(session.id) ?? false);
            if (renamingId === session.id) {
              return (
                <div key={session.id}>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !isComposingKey(e)) commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={commitRename}
                    className="w-full bg-bg-0 border border-accent rounded-[5px] px-2 py-[3px] text-sm leading-5 text-text-100 outline-none"
                  />
                </div>
              );
            }
            const pr = sessionPrs[session.id];
            const nestedFolded = foldedParents.has(session.id);
            const unread = !isActive && marks.unread.includes(session.id);
            const isSelected = selected ? selected.has(session.id) : undefined;
            return (
              <div
                key={session.id}
                className="group relative"
                style={depth ? { paddingLeft: depth * NEST_INDENT } : undefined}
                onContextMenu={(e) => contextMenuAt(e, session.id)}
                {...titleTooltip(session.title, menuOpen)}
              >
                {depth > 0 && (
                  // The line from the parent above, bending into this row; it carries on down
                  // to the parent's next session unless this is the last one.
                  <span
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute top-0 w-[7px] border-l border-text-500/50",
                      last ? "h-1/2 border-b rounded-bl-[4px]" : "h-full",
                    )}
                    style={{ left: (depth - 1) * NEST_INDENT + 13 }}
                  />
                )}
                {depth > 0 && !last && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute top-0 h-1/2 w-[7px] border-b border-text-500/50"
                    style={{ left: (depth - 1) * NEST_INDENT + 13 }}
                  />
                )}
                <button
                  onClick={() => (selected ? toggleSelected(session.id) : onSelectSession?.(session.id))}
                  aria-pressed={isSelected}
                  draggable={!!onOpenToSide && !isActive && !selected}
                  onDragStart={(e) => dragToSide(e, session.id)}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1 rounded-[5px] text-sm leading-5 text-left transition-colors",
                    isSelected
                      ? "bg-accent/10 text-text-100"
                      : isActive && !selected
                        ? "bg-bg-200 text-text-100"
                        : unread
                          ? "text-text-100 font-medium hover:bg-bg-200"
                          : "text-text-300 hover:bg-bg-200 hover:text-text-200",
                  )}
                >
                  <ChatStatus
                    working={working}
                    needsAttention={needsAttention}
                    attentionLabel={t.needsPermission}
                    idleLabel={t.inactive}
                    pr={pr}
                    prLabel={pr ? prLabels[pr.status] : undefined}
                    prProblem={pr?.status === "unknown" ? ghProblemText(pr.problem, tGit) : undefined}
                    unread={unread}
                    unreadLabel={tm.unread}
                    selected={isSelected}
                  />
                  {sessionStates?.[session.id] && (
                    <span
                      className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", SESSION_STATE_META[sessionStates[session.id]].cls)}
                      data-tooltip={SESSION_STATE_META[sessionStates[session.id]].tip}
                    >
                      {SESSION_STATE_META[sessionStates[session.id]].label}
                    </span>
                  )}
                  <span
                    data-tooltip-clip-target
                    className={cn(
                      // A parent's fold arrow sits right after its title.
                      descendants > 0 ? "min-w-0" : "flex-1 min-w-0",
                      "overflow-hidden whitespace-nowrap",
                      // The fade ends where the hover menu button starts covering the row. A
                      // parent's box hugs its title (the menu button covers the fold arrow, not
                      // the text), so it only gets a short fade in case the title is cut.
                      descendants > 0
                        ? "group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%_-_12px),transparent)]"
                        : menuOpen
                          ? "[mask-image:linear-gradient(to_right,#000_calc(100%_-_32px),transparent_calc(100%_-_20px))]"
                          : "group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%_-_32px),transparent_calc(100%_-_20px))]",
                    )}
                  >
                    {session.title ? (
                      // A session at work: the same light wave as the chat's status line, over its title.
                      working ? <TextShimmer>{session.title}</TextShimmer> : session.title
                    ) : (
                      <span className="italic text-text-400">{working ? "…" : tm.untitled}</span>
                    )}
                  </span>
                  {descendants > 0 && (
                    // Inside the row's button, so it is a span: a click folds the nested sessions
                    // without opening this one.
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-expanded={!nestedFolded}
                      aria-label={nestedFolded ? t.showNested : t.hideNested}
                      onClick={(e) => { e.stopPropagation(); toggleNested(session.id); }}
                      className="shrink-0 mr-auto p-0.5 rounded text-text-400 hover:text-text-100 hover:bg-bg-300"
                    >
                      <ChevronDown className={cn("w-3 h-3 transition-transform", nestedFolded && "-rotate-90")} />
                    </span>
                  )}
                  {byProject && (
                    <span
                      className={cn(
                        "shrink-0 text-[11.5px] tabular-nums text-text-500 transition-opacity",
                        menuOpen ? "opacity-0" : "group-hover:opacity-0",
                      )}
                    >
                      {shortAge(session.modifiedAt, now)}
                    </span>
                  )}
                </button>

                {!selected && (
                  <button
                    aria-label={tm.sessionOptions}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setChatMenu({ id: session.id, x: r.left, y: r.bottom + 4, above: r.top - 4 });
                    }}
                    data-tooltip-clip-cover
                    className={cn(
                      "absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-300 hover:bg-bg-300 transition-opacity",
                      menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <EllipsisVertical className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
              })}
            </div>
            );
          })
        ) : (sessions.length > 0 || archivedSessions.length > 0) && isRecentsFilterActive(recentsFilter) ? (
          <div className="px-3 py-8 text-center">
            <p className="text-[13px] text-text-400">{tm.noFilterMatches}</p>
            <button
              type="button"
              onClick={() => setRecentsFilter(DEFAULT_RECENTS_FILTER)}
              className="mt-2 text-[13px] font-medium text-text-200 underline underline-offset-2 hover:text-text-100 transition-colors"
            >
              {tm.showAllSessions}
            </button>
          </div>
        ) : chats.length > 0 ? (
          chats.map((chat) => {
            const isActive = chat.id === activeChatId;
            const menuOpen = chatMenu?.id === chat.id;
            if (renamingId === chat.id) {
              return (
                <div key={chat.id}>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !isComposingKey(e)) commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={commitRename}
                    className="w-full bg-bg-0 border border-accent rounded-[5px] px-2 py-[3px] text-sm leading-5 text-text-100 outline-none"
                  />
                </div>
              );
            }
            const chatWorking = streamingChatIds?.has(chat.id) ?? false;
            const chatAttention = (awaitingPermissionChatIds?.has(chat.id) ?? false) || (awaitingQuestionChatIds?.has(chat.id) ?? false);
            return (
              <div key={chat.id} className="group relative" onContextMenu={(e) => contextMenuAt(e, chat.id)} {...titleTooltip(chat.title, menuOpen)}>
                <button
                  onClick={() => onSelectChat(chat.id)}
                  draggable={!!onOpenToSide && !isActive}
                  onDragStart={(e) => dragToSide(e, chat.id)}
                  className={cn(
                    "w-full flex items-center gap-1.5 px-2 py-1 rounded-[5px] text-sm leading-5 text-left transition-colors",
                    isActive ? "bg-bg-200 text-text-100" : "text-text-300 hover:bg-bg-200 hover:text-text-200",
                  )}
                >
                  <ChatStatus working={chatWorking} needsAttention={chatAttention} attentionLabel={t.needsPermission} idleLabel={t.inactive} />
                  <span
                    data-tooltip-clip-target
                    className={cn(
                      "flex-1 min-w-0 overflow-hidden whitespace-nowrap",
                      menuOpen
                        ? "[mask-image:linear-gradient(to_right,#000_calc(100%_-_32px),transparent_calc(100%_-_20px))]"
                        : "[mask-image:linear-gradient(to_right,#000_calc(100%_-_12px),transparent)] group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%_-_32px),transparent_calc(100%_-_20px))]",
                    )}
                  >
                    {chatWorking && chat.title ? <TextShimmer>{chat.title}</TextShimmer> : chat.title}
                  </span>
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setChatMenu({ id: chat.id, x: r.left, y: r.bottom + 4, above: r.top - 4 });
                  }}
                  data-tooltip-clip-cover
                  className={cn(
                    "absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-300 hover:bg-bg-300 transition-opacity",
                    menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <EllipsisVertical className="w-4 h-4" />
                </button>
              </div>
            );
          })
        ) : (
          <p className="px-2 text-xs text-text-400">{t.noChats}</p>
        )}
      </div>
      {selected && (
        // Selection mode's actions, under the list: what to do with the rows picked.
        <div role="toolbar" aria-label={tm.selection} className="mx-2 mb-1 flex items-center gap-1 rounded-[6px] border border-bg-300 bg-bg-100 px-2 py-1.5">
          <span className="flex-1 min-w-0 truncate text-[12.5px] text-text-300">{tm.selectedCount.replace("{count}", String(selected.size))}</span>
          <button
            type="button"
            disabled={!selected.size}
            onClick={() => {
              onArchiveSessions?.([...selected]);
              setSelected(null);
            }}
            className="px-2 py-0.5 rounded-[5px] text-[12.5px] text-text-200 hover:bg-bg-200 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            {tm.archive}
          </button>
          <button
            type="button"
            disabled={!selected.size}
            onClick={() => setPendingBulkDelete([...selected])}
            className="px-2 py-0.5 rounded-[5px] text-[12.5px] text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            {tm.delete}
          </button>
          <button
            type="button"
            aria-label={tm.cancelSelection}
            onClick={() => setSelected(null)}
            className="p-1 rounded-[5px] text-text-400 hover:text-text-100 hover:bg-bg-200 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      </>
      )}

      <UpdateAlert />

      <div className="px-2 py-2 relative" ref={accountRef}>
        <button
          onClick={() => setAccountOpen((o) => !o)}
          className="max-w-full inline-flex items-center gap-2 px-2 py-1 rounded-[5px] hover:bg-bg-200 transition-colors"
        >
          {user?.picture ? (
            <img src={user.picture} alt="" className="w-5 h-5 shrink-0 rounded-full object-cover" referrerPolicy="no-referrer" draggable={false} />
          ) : (
            <span className="w-5 h-5 shrink-0 rounded-full bg-accent flex items-center justify-center text-[9px] font-bold text-bg-0">
              {user ? userInitials(user) : t.productInitials}
            </span>
          )}
          <span className="min-w-0 text-left text-sm leading-5 text-text-100 truncate">
            {user ? (user.name || user.email) : t.productLabel}
          </span>
          <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 text-text-400 transition-transform", accountOpen && "rotate-180")} />
        </button>

        {accountOpen && (
          <div data-mod-menu className="absolute bottom-full left-2 mb-2 w-72 bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-[70] p-1.5">
            <div className="px-2 py-1.5 text-[12px] text-text-400 truncate" data-tooltip={user?.email ?? t.accountEmail}>
              {user?.email ?? t.accountEmail}
            </div>
            <div className="h-px bg-bg-300 my-1" />
            <MenuItem icon={Settings} label={t.settings} shortcut="Ctrl ," onClick={onOpenSettings} close={() => setAccountOpen(false)} />

            <div className="relative" onMouseEnter={openLang} onMouseLeave={closeLang}>
              <button
                onClick={openLang}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 transition-colors",
                  langOpen ? "bg-bg-200" : "hover:bg-bg-200",
                )}
              >
                <Languages className="w-4 h-4 text-text-300 shrink-0" />
                <span className="flex-1 text-left">{t.language}</span>
                <ChevronRight className="w-3.5 h-3.5 text-text-400" />
              </button>
              {langOpen && (
                <div
                  data-mod-menu
                  onMouseEnter={openLang}
                  onMouseLeave={closeLang}
                  className="absolute left-full bottom-0 ml-1 w-56 max-h-[70vh] overflow-y-auto custom-scrollbar bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl z-[70] p-1.5"
                >
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.code}
                      onClick={() => selectLang(l.code)}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
                    >
                      <span>{l.label}</span>
                      {language === l.code && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <MenuItem icon={LifeBuoy} label={t.getHelp} onClick={onOpenHelp} close={() => setAccountOpen(false)} />
            <MenuItem icon={MessageSquareHeart} label={t.feedback} onClick={() => setFeedbackOpen(true)} close={() => setAccountOpen(false)} />
            <MenuItem icon={History} label={t.viewChangelog} onClick={() => setChangelogOpen(true)} close={() => setAccountOpen(false)} />
            <LearnMoreMenu language={language} close={() => setAccountOpen(false)} />
            <div className="h-px bg-bg-300 my-1" />
            <MenuItem icon={LogOut} label={t.logOut} onClick={() => void handleSignOut()} close={() => setAccountOpen(false)} />
          </div>
        )}
      </div>

      {chatMenu && (
        <SessionMenu
          key={`${chatMenu.id}:${chatMenu.x}:${chatMenu.y}`}
          target={menuTarget(chatMenu.id)}
          x={chatMenu.x}
          y={chatMenu.y}
          above={chatMenu.above}
          canSplit={!!onOpenToSide && chatMenu.id !== activeChatId}
          canRewind={!!onRewindSession}
          projects={projects}
          sections={marks.sections}
          onAction={(a) => runMenuAction(chatMenu.id, a)}
          onClose={() => setChatMenu(null)}
        />
      )}

      {sectionMenu && (
        <>
          <div className="fixed inset-0 z-[69]" onClick={() => setSectionMenu(null)} />
          <div
            data-mod-menu
            role="menu"
            data-webview-hole
            className="fixed z-[70] w-52 bg-bg-100 border border-bg-300 rounded-[6px] shadow-2xl p-1.5"
            style={{ left: sectionMenu.x, top: sectionMenu.y }}
          >
            <button
              role="menuitem"
              onClick={() => {
                const s = marks.sections.find((x) => x.id === sectionMenu.id);
                sectionRenameCancelled.current = false;
                if (s) setRenamingSection({ id: s.id, name: s.name });
                setSectionMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
            >
              <Pencil className="w-4 h-4 text-text-300 shrink-0" />
              {tm.renameSection}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                deleteSection(sectionMenu.id);
                setSectionMenu(null);
              }}
              className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-4 h-4 shrink-0" />
              {tm.deleteSection}
            </button>
          </div>
        </>
      )}

      <Dialog open={!!newSection} onClose={() => setNewSection(null)} className="max-w-sm">
        <DialogHeader>
          <Layers className="w-4 h-4 text-accent" />
          <DialogTitle>{tm.newSectionTitle}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = stripKeyChars(newSection?.name ?? "").trim();
            if (!newSection || !name) return;
            createSection(name, newSection.ids);
            setNewSection(null);
          }}
        >
          <div className="px-4">
            <input
              autoFocus
              aria-label={tm.sectionName}
              value={newSection?.name ?? ""}
              onChange={(e) => setNewSection((s) => (s ? { ...s, name: e.target.value } : s))}
              placeholder={tm.sectionName}
              maxLength={60}
              className="w-full bg-bg-0 border border-bg-300 rounded-[6px] px-2.5 py-1.5 text-[13px] text-text-100 outline-none focus:border-accent"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setNewSection(null)}>{tm.cancelSelection}</Button>
            <Button type="submit" variant="primary" disabled={!newSection?.name.trim()}>{tm.createSection}</Button>
          </DialogFooter>
        </form>
      </Dialog>

      {pendingBulkDelete && (
        <ConfirmDialog
          title={tm.deleteSelectedTitle.replace("{count}", String(pendingBulkDelete.length))}
          message={tm.deleteSelectedDesc}
          cancelLabel={t.deleteSessionCancel}
          confirmLabel={t.deleteSessionConfirm}
          danger
          onCancel={() => setPendingBulkDelete(null)}
          onConfirm={() => {
            onDeleteSessions?.(pendingBulkDelete);
            setPendingBulkDelete(null);
            setSelected(null);
          }}
        />
      )}

      {projectMenu && (
        <>
          <div className="fixed inset-0 z-[69]" onClick={() => setProjectMenu(null)} />
          <div
            data-mod-menu
            data-webview-hole
            className="fixed z-[70] w-56 bg-bg-100 border border-bg-300 rounded-[5px] shadow-2xl p-1.5"
            style={{ left: projectMenu.x, top: projectMenu.y }}
          >
            {onNewSessionIn && (
              <button
                onClick={() => { onNewSessionIn(projectMenu.workspace); setProjectMenu(null); }}
                className="w-full flex items-center px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
              >
                {t.newSessionHere}
              </button>
            )}
            {onOpenFolder && (
              <button
                onClick={() => { onOpenFolder(projectMenu.workspace); setProjectMenu(null); }}
                className="w-full flex items-center px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
              >
                {t.openFolder}
              </button>
            )}
            {onRemoveProject && projectMenu.workspace !== currentWorkspace && (
              <>
                <div className="h-px bg-bg-300 my-1" />
                <button
                  onClick={() => { onRemoveProject(projectMenu.workspace); setProjectMenu(null); }}
                  className="w-full flex items-center px-2 py-1.5 rounded-[5px] text-[13px] text-text-100 hover:bg-bg-200 transition-colors"
                >
                  {t.removeFromList}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t.deleteSessionTitle}
          message={
            (pendingDelete.nested
              ? (pendingDelete.nested === 1 ? t.deleteNestedDescOne : t.deleteNestedDesc)
                  .replace("{title}", pendingDelete.title)
                  .replace("{count}", String(pendingDelete.nested))
              : t.deleteSessionDesc.replace("{title}", pendingDelete.title)) +
            (pendingDelete.dirty?.length
              ? " " + tGuard.deleteNote.replace("{count}", String(pendingDelete.dirty.length)).replace("{files}", shortFileList(pendingDelete.dirty))
              : "")
          }
          cancelLabel={t.deleteSessionCancel}
          confirmLabel={pendingDelete.nested ? t.deleteOnlyThis : t.deleteSessionConfirm}
          alternative={
            pendingDelete.nested
              ? {
                  label: t.deleteWithNested.replace("{count}", String(pendingDelete.nested + 1)),
                  onClick: () => {
                    onDeleteSession?.(pendingDelete.id, true);
                    setPendingDelete(null);
                  },
                }
              : undefined
          }
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (pendingDelete.isSession) onDeleteSession?.(pendingDelete.id);
            else onDeleteChat(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      )}

      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

    </aside>
  );
}

export default Sidebar;
