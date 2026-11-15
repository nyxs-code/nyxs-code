import { useRef, useState, type ReactNode } from "react";
import {
  Archive,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Columns2,
  Copy,
  FileText,
  FolderInput,
  FolderOpen,
  GitFork,
  Hash,
  Layers,
  ListChecks,
  Mail,
  MailOpen,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "@/lib/i18n";
import type { SessionCopy } from "@/lib/sessionExport";
import { useMenuTop } from "@/lib/useMenuTop";
import { cn } from "@/lib/utils";
import { workspaceName } from "@/lib/workspace";

export type { SessionCopy };

/** What a pick on a session's menu asks for. */
export type SessionMenuAction =
  | "split"
  | "sideChat"
  | "fork"
  | "schedule"
  | "select"
  | "rename"
  | "rewind"
  | "pin"
  | "unpin"
  | "markUnread"
  | "markRead"
  | "archive"
  | "delete"
  | "newSection"
  | { copy: SessionCopy }
  | { moveTo: string }
  | { section: string | null };

/** The session the menu is for, as far as the menu needs to know it. */
export interface SessionMenuTarget {
  id: string;
  /** Saved as a session (an unsaved chat has no id on disk and offers less). */
  saved: boolean;
  isActive: boolean;
  /** A reply is running. */
  working: boolean;
  hasMessages: boolean;
  workspace: string | null;
  /** Runs in a worktree of its project, which can't go to another project. */
  worktree: boolean;
  pinned: boolean;
  unread: boolean;
  sectionId: string | null;
}

type Sub = "copy" | "project" | "section";

function Row({
  icon: Icon,
  label,
  hint,
  arrow,
  danger,
  disabled,
  open,
  checked,
  onClick,
  onHover,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  arrow?: boolean;
  danger?: boolean;
  disabled?: boolean;
  open?: boolean;
  checked?: boolean;
  onClick?: () => void;
  onHover?: (row: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      aria-haspopup={arrow || undefined}
      aria-expanded={arrow ? !!open : undefined}
      onClick={() => !disabled && onClick?.()}
      onMouseEnter={(e) => onHover?.(e.currentTarget)}
      className={cn(
        "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[5px] text-[13px] text-left transition-colors",
        disabled
          ? "text-text-500 cursor-default"
          : danger
            ? "text-red-400 hover:bg-red-500/10"
            : open
              ? "bg-bg-200 text-text-100"
              : "text-text-100 hover:bg-bg-200",
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", disabled ? "text-text-500" : danger ? "text-red-400" : "text-text-300")} />
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-text-500">{hint}</span>}
      {checked && <Check className="w-3.5 h-3.5 shrink-0 text-accent" />}
      {arrow && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-text-400" />}
    </button>
  );
}

const Sep = () => <div className="h-px bg-bg-300 my-1" />;

const PANEL = "bg-bg-100 border border-bg-300 rounded-[6px] shadow-2xl p-1.5";

/**
 * A session's menu in Recents (its ⋮ button or a right click): open it beside the open one or
 * with a side chat, fork it, schedule a task from it, copy it out, move it to another project or
 * one of the user's sections, select several, rename, pin, mark it unread, archive or delete it.
 * Copy and both moves open a submenu on hover.
 */
export function SessionMenu({
  target,
  x,
  y,
  above,
  canSplit,
  canRewind,
  projects,
  sections,
  onAction,
  onClose,
}: {
  target: SessionMenuTarget;
  x: number;
  /** Just under the ⋮ button, and just over it, where the menu goes when it doesn't fit below. */
  y: number;
  above: number;
  canSplit: boolean;
  canRewind: boolean;
  /** The project folders a session can move to. */
  projects: string[];
  sections: { id: string; name: string }[];
  onAction: (action: SessionMenuAction) => void;
  onClose: () => void;
}) {
  const tm = useTranslations().sidebarMenu;
  const ref = useRef<HTMLDivElement>(null);
  const top = useMenuTop(ref, y, above);
  const [sub, setSub] = useState<{ which: Sub; up: boolean } | null>(null);
  const closeTimer = useRef<number | null>(null);

  const pick = (a: SessionMenuAction) => {
    onAction(a);
    onClose();
  };
  const keepSub = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  };
  const openSub = (which: Sub, row: HTMLElement) => {
    keepSub();
    // In the lower half of the window the submenu grows upwards from its row.
    setSub({ which, up: row.getBoundingClientRect().top > window.innerHeight / 2 });
  };
  const leaveSub = () => {
    keepSub();
    closeTimer.current = window.setTimeout(() => setSub(null), 200);
  };
  // Rows without a submenu close the one open, as a menu does.
  const plain = () => setSub(null);

  const { saved, hasMessages } = target;
  const otherProjects = projects.filter((p) => p !== target.workspace);
  const canMove = saved && !target.worktree && !target.working;

  const submenu = (which: Sub, body: ReactNode) =>
    sub?.which === which && (
      <div
        role="menu"
        onMouseEnter={keepSub}
        onMouseLeave={leaveSub}
        className={cn("absolute left-full ml-1 w-60 z-[71]", sub.up ? "bottom-0 -mb-1.5" : "top-0 -mt-1.5", PANEL)}
      >
        {body}
      </div>
    );

  return (
    <>
      <div className="fixed inset-0 z-[69]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        role="menu"
        data-webview-hole
        className={cn("fixed z-[70] w-60", PANEL)}
        style={{ left: x, top: top ?? y }}
      >
        {canSplit && <Row icon={Columns2} label={tm.openInSplit} onHover={plain} onClick={() => pick("split")} />}
        <Row icon={MessageSquarePlus} label={tm.newSideChat} hint="Ctrl+J" disabled={!hasMessages || !saved} onHover={plain} onClick={() => pick("sideChat")} />
        <Row icon={GitFork} label={tm.fork} disabled={!saved || !hasMessages} onHover={plain} onClick={() => pick("fork")} />
        <Row icon={Clock} label={tm.addScheduledTask} disabled={!target.workspace} onHover={plain} onClick={() => pick("schedule")} />
        <Sep />
        <div className="relative" onMouseLeave={leaveSub}>
          <Row icon={Copy} label={tm.copy} arrow open={sub?.which === "copy"} onHover={(row) => openSub("copy", row)} onClick={() => setSub(null)} />
          {submenu(
            "copy",
            <>
              <Row icon={Bot} label={tm.copyForModel} disabled={!hasMessages} onClick={() => pick({ copy: "handoff" })} />
              <Row icon={FileText} label={tm.copyMarkdown} disabled={!hasMessages} onClick={() => pick({ copy: "markdown" })} />
              <Row icon={Hash} label={tm.copySessionId} disabled={!saved} onClick={() => pick({ copy: "id" })} />
              <Row icon={FolderOpen} label={tm.copyWorkingDir} disabled={!target.workspace} onClick={() => pick({ copy: "dir" })} />
            </>,
          )}
        </div>
        <div className="relative" onMouseLeave={leaveSub}>
          <Row
            icon={FolderInput}
            label={tm.moveToProject}
            arrow={canMove}
            disabled={!canMove}
            open={sub?.which === "project"}
            onHover={(row) => (canMove ? openSub("project", row) : plain())}
          />
          {submenu(
            "project",
            otherProjects.length ? (
              otherProjects.map((p) => <Row key={p} icon={FolderOpen} label={workspaceName(p)} onClick={() => pick({ moveTo: p })} />)
            ) : (
              <Row icon={FolderOpen} label={tm.noOtherProjects} disabled />
            ),
          )}
        </div>
        <div className="relative" onMouseLeave={leaveSub}>
          <Row
            icon={Layers}
            label={tm.moveToSection}
            arrow={saved}
            disabled={!saved}
            open={sub?.which === "section"}
            onHover={(row) => (saved ? openSub("section", row) : plain())}
          />
          {submenu(
            "section",
            <>
              {sections.map((s) => (
                <Row key={s.id} icon={Layers} label={s.name} checked={s.id === target.sectionId} onClick={() => pick({ section: s.id === target.sectionId ? null : s.id })} />
              ))}
              {target.sectionId && <Row icon={X} label={tm.removeFromSection} onClick={() => pick({ section: null })} />}
              {sections.length > 0 && <Sep />}
              <Row icon={Plus} label={tm.newSection} onClick={() => pick("newSection")} />
            </>,
          )}
        </div>
        <Sep />
        <Row icon={ListChecks} label={tm.select} disabled={!saved} onHover={plain} onClick={() => pick("select")} />
        <Row icon={Pencil} label={tm.rename} onHover={plain} onClick={() => pick("rename")} />
        {canRewind && <Row icon={Undo2} label={tm.revertFiles} disabled={!saved} onHover={plain} onClick={() => pick("rewind")} />}
        <Row icon={target.pinned ? PinOff : Pin} label={target.pinned ? tm.unpin : tm.pin} disabled={!saved} onHover={plain} onClick={() => pick(target.pinned ? "unpin" : "pin")} />
        <Row
          icon={target.unread ? MailOpen : Mail}
          label={target.unread ? tm.markRead : tm.markUnread}
          disabled={!saved || target.isActive}
          onHover={plain}
          onClick={() => pick(target.unread ? "markRead" : "markUnread")}
        />
        <Sep />
        <Row icon={Archive} label={tm.archive} disabled={!saved} onHover={plain} onClick={() => pick("archive")} />
        <Row icon={Trash2} label={tm.delete} danger onHover={plain} onClick={() => pick("delete")} />
      </div>
    </>
  );
}
