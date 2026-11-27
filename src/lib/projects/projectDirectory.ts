import { useSyncExternalStore } from "react";
import { projectDot, threadGroup, type ThreadGroup } from "./threadStatus";
import type { Project, ProjectRole, ProjectSessionFields, ThreadLocation, ThreadStatus } from "./types";

/** One thread as the project page, the sidebar, the cards and the coordinator's tools see it. */
export interface ThreadEntry {
  id: string;
  projectId: string;
  /** Its session's title (the user may rename it). */
  title: string;
  /** The title the coordinator gave it, which its card finds it by. */
  threadTitle: string;
  /** The coordinator session it is nested under. */
  parentId?: string;
  parentMessageId?: string;
  status?: ThreadStatus;
  group: ThreadGroup;
  branch?: string;
  location?: ThreadLocation;
  updatedAt: number;
  preview?: string;
  /** Its agent's replies so far. */
  replies: number;
  streaming: boolean;
  blocked: boolean;
  workspace?: string | null;
}

export interface ProjectEntry {
  project: Project;
  threads: ThreadEntry[];
  coordinator: { streaming: boolean; blocked: boolean };
  dot: "waiting" | "working" | null;
}

/** What a session of a project looks like to the directory: a saved summary or a live chat. */
export interface ProjectSessionSource extends ProjectSessionFields {
  id: string;
  title: string;
  parentId?: string;
  workspace?: string | null;
  archived?: boolean;
  modifiedAt?: number;
  /** Lines in its transcript (a saved summary). */
  messageCount?: number;
  /** Its messages, when loaded (a live chat). */
  messages?: { role: string }[];
  worktree?: { path: string; branch: string };
}

/** Every project with its threads, newest change first. Live chats win over saved summaries:
 *  they carry the status a turn just set. */
export function buildProjectDirectory(
  projects: Project[],
  saved: ProjectSessionSource[],
  live: ProjectSessionSource[],
  streaming: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
  now: number,
): ProjectEntry[] {
  const byId = new Map<string, ProjectSessionSource>();
  for (const s of saved) if (s.projectId) byId.set(s.id, s);
  for (const c of live) {
    if (!c.projectId) continue;
    const before = byId.get(c.id);
    // A live chat whose messages aren't loaded yet still counts its saved ones.
    byId.set(c.id, { ...before, ...c, messageCount: before?.messageCount, modifiedAt: before?.modifiedAt ?? c.modifiedAt });
  }
  return projects.map((project) => {
    const threads: ThreadEntry[] = [];
    for (const s of byId.values()) {
      if (s.projectId !== project.id || s.projectRole !== "thread" || s.archived) continue;
      const isStreaming = streaming.has(s.id);
      const isBlocked = blocked.has(s.id);
      const updatedAt = s.threadUpdatedAt ?? s.modifiedAt ?? 0;
      const loadedReplies = s.messages?.length ? s.messages.filter((m) => m.role === "assistant").length : null;
      threads.push({
        id: s.id,
        projectId: project.id,
        title: s.title || s.threadTitle || s.id,
        threadTitle: s.threadTitle || s.title,
        parentId: s.parentId,
        parentMessageId: s.parentMessageId,
        status: s.threadStatus,
        group: threadGroup({ status: s.threadStatus, streaming: isStreaming, blocked: isBlocked, updatedAt }, now),
        branch: s.worktree?.branch,
        location: s.threadLocation,
        updatedAt,
        preview: s.threadPreview,
        replies: loadedReplies ?? Math.floor((s.messageCount ?? 0) / 2),
        streaming: isStreaming,
        blocked: isBlocked,
        workspace: s.workspace,
      });
    }
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    const coordinator = { streaming: streaming.has(project.coordinatorChatId), blocked: blocked.has(project.coordinatorChatId) };
    return { project, threads, coordinator, dot: projectDot(threads.map((t) => t.group), coordinator) };
  });
}

let entries: ProjectEntry[] = [];
const roles = new Map<string, { projectId: string; role: ProjectRole }>();
const listeners = new Set<() => void>();

export function setProjectDirectory(next: ProjectEntry[], sessionRoles: Iterable<[string, { projectId: string; role: ProjectRole }]>): void {
  for (const [id, r] of sessionRoles) roles.set(id, r);
  for (const p of next) roles.set(p.project.coordinatorChatId, { projectId: p.project.id, role: "coordinator" });
  if (JSON.stringify(next) === JSON.stringify(entries)) return;
  entries = next;
  listeners.forEach((l) => l());
}

/** A session that just became part of a project: its first turn starts before the directory
 *  is published again, and its tools and prompt must already know. */
export function noteProjectRole(chatId: string, projectId: string, role: ProjectRole): void {
  roles.set(chatId, { projectId, role });
}

export function projectRoleOf(chatId: string | undefined | null): { projectId: string; role: ProjectRole } | null {
  return (chatId && roles.get(chatId)) || null;
}

export function projectEntries(): ProjectEntry[] {
  return entries;
}

export function projectEntry(projectId: string | undefined | null): ProjectEntry | undefined {
  return projectId ? entries.find((e) => e.project.id === projectId) : undefined;
}

export function findThread(threadId: string): ThreadEntry | undefined {
  for (const e of entries) {
    const t = e.threads.find((x) => x.id === threadId);
    if (t) return t;
  }
  return undefined;
}

/** The thread `coordinatorId` opened with this title (the newest, if there are several). */
export function findThreadByTitle(coordinatorId: string | undefined, title: string): ThreadEntry | undefined {
  if (!coordinatorId) return undefined;
  const wanted = title.trim().toLowerCase();
  for (const e of entries) {
    if (e.project.coordinatorChatId !== coordinatorId) continue;
    return e.threads.find((t) => t.threadTitle.trim().toLowerCase() === wanted);
  }
  return undefined;
}

export function useProjectDirectory(): ProjectEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries,
  );
}

export function resetProjectDirectoryForTests(): void {
  entries = [];
  roles.clear();
  listeners.forEach((l) => l());
}
