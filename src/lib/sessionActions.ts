import type { Dispatch, SetStateAction } from "react";
import type { ConfirmOptions } from "@/components/ConfirmDialog";
import { shortFileList, uncommittedSessionFiles, uncommittedWorktreeFiles } from "@/lib/archiveGuard";
import { forkChat } from "@/lib/chatMessages";
import { deleteChatFile, type Chat } from "@/lib/chatStore";
import { closeClaudeCodeChat } from "@/lib/claudeCode";
import { warnUncommittedArchive } from "@/lib/featureSettings";
import type { FileHistoryState } from "@/lib/fileHistory";
import { newChatId } from "@/lib/sendMessage";
import { carryMarks, forgetSessions } from "@/lib/sessionMarks";
import { sessionHandoff, sessionMarkdown, type SessionCopy } from "@/lib/sessionExport";
import {
  canRewindSession,
  deleteSessionFamily,
  readSession,
  rewindSessionFiles,
  saveSession,
  sessionFamilyIds,
  sessionRewindPoints,
  setSessionArchived,
  type SessionSummary,
} from "@/lib/sessionStorage";
import type { Translations } from "@/locales/types";

/** What the sidebar's and the transcript's session actions read and change in the app; built
 *  when an action runs. */
export interface SessionActionsEnv {
  t: Translations;
  workspace: string | null;
  sessions: SessionSummary[];
  chats: Chat[];
  /** The chats as they are right now. */
  liveChats: () => Chat[];
  activeId: string | null;
  /** An open chat's file history in memory, which can be ahead of what's saved. */
  liveFileHistory: (chatId: string) => FileHistoryState | undefined;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  setActiveId: (id: string | null) => void;
  refreshSessions: () => void;
  /** Takes deleted sessions off the lists without waiting for a refresh (see useSessionList). */
  dropSessions: (ids: string[], parentId: string, newParent: string | undefined) => void;
  /** Chats whose messages are in memory. */
  hydrated: Set<string>;
  dropChatViews: (chatId: string) => void;
  streaming: (chatId: string) => boolean;
  abortTurn: (chatId: string) => void;
}

const workspaceOf = (id: string, env: SessionActionsEnv) => env.sessions.find((s) => s.id === id)?.workspace ?? env.workspace ?? null;

/** Files a session changed that are still uncommitted, when archiving or deleting it should
 *  warn about them (none when that warning is off). */
export async function uncommittedFilesOf(id: string, env: SessionActionsEnv): Promise<string[]> {
  const sessionWs = workspaceOf(id, env);
  if (!sessionWs || !warnUncommittedArchive()) return [];
  const chat = env.chats.find((c) => c.id === id);
  const live = [...(env.liveFileHistory(id)?.trackedFiles ?? []), ...(chat?.fileHistory?.trackedFiles ?? [])];
  const ownTree = chat?.worktree?.path ?? env.sessions.find((s) => s.id === id)?.worktree?.path;
  return (ownTree ? uncommittedWorktreeFiles(ownTree) : uncommittedSessionFiles(sessionWs, id, live)).catch(() => []);
}

/** Archives a session, first asking when files it changed are still uncommitted. */
export async function archiveSession(id: string, env: SessionActionsEnv): Promise<void> {
  const { t } = env;
  const dirty = await uncommittedFilesOf(id, env);
  if (dirty.length) {
    const ok = await env.confirm({
      title: t.archiveGuard.title,
      message: t.archiveGuard.body.replace("{count}", String(dirty.length)).replace("{files}", shortFileList(dirty)),
      confirmLabel: t.archiveGuard.confirm,
      cancelLabel: t.modals.cancel,
    });
    if (!ok) return;
  }
  await setSessionArchived(workspaceOf(id, env), id, true, Date.now());
  env.refreshSessions();
}

/** Brings an archived session back to the sidebar. */
export async function unarchiveSession(session: SessionSummary, env: Pick<SessionActionsEnv, "refreshSessions">): Promise<void> {
  await setSessionArchived(session.workspace ?? null, session.id, false);
  env.refreshSessions();
}

/** Puts back the files a saved session changed, after asking, and says how it went. */
export async function rewindSavedSession(sessionId: string, env: SessionActionsEnv): Promise<void> {
  const tApp = env.t.app;
  const ws = env.sessions.find((s) => s.id === sessionId)?.workspace ?? env.workspace;
  if (!ws) return;
  const fh = (await readSession(ws, sessionId))?.fileHistory ?? null;
  if (!canRewindSession(fh)) {
    await env.confirm({ title: tApp.revertSessionNone, confirmLabel: tApp.ok });
    return;
  }
  const files = sessionRewindPoints(fh)[0]?.fileCount ?? 0;
  const ok = await env.confirm({
    title: tApp.revertSessionTitle,
    message: tApp.revertSessionDesc.replace("{count}", String(files)),
    confirmLabel: tApp.revertSessionConfirm,
    cancelLabel: env.t.modals.cancel,
    danger: true,
  });
  if (!ok) return;
  const res = await rewindSessionFiles(ws, sessionId, fh);
  await env.confirm({
    title: res ? tApp.revertSessionDone.replace("{count}", String(res.changed)) : tApp.revertSessionNothing,
    // The same rule and words as the rewind dialog: what someone else changed stays.
    message: res?.kept.length ? `${env.t.message.rewindKept} ${shortFileList(res.kept)}` : undefined,
    confirmLabel: tApp.ok,
  });
}

/** A chat that's gone takes its turn and its Claude Code process with it (the process ends
 *  once a stopped turn has wound down). */
export function endChatAgent(id: string, env: SessionActionsEnv): void {
  if (env.streaming(id)) env.abortTurn(id);
  closeClaudeCodeChat(id, (env.chats.find((c) => c.id === id)?.messages ?? []).map((m) => m.responseMessages));
}

/** Deletes a chat that isn't saved as a session. */
export function deleteChat(id: string, env: SessionActionsEnv): void {
  endChatAgent(id, env);
  env.setChats((prev) => prev.filter((c) => c.id !== id));
  if (env.activeId === id) env.setActiveId(null);
  env.dropChatViews(id);
  env.hydrated.delete(id);
  void deleteChatFile(id);
}

/** Deletes a saved session, with the sessions nested under it or handing them to its parent. */
export async function deleteSession(id: string, withNested: boolean, env: SessionActionsEnv): Promise<void> {
  const removed = sessionFamilyIds(id, withNested, env.sessions);
  const newParent = env.sessions.find((s) => s.id === id)?.parentId;
  // Started first: it marks the sessions deleted before it awaits anything, so the save a
  // stopped turn makes below writes nothing back.
  const deleting = deleteSessionFamily(id, withNested, env.sessions, env.workspace);
  // Off the screen right away: deleting waits for saves already queued for the session, and the
  // row used to stay until every folder was listed again.
  env.dropSessions(removed, id, newParent);
  forgetSessions(removed);
  for (const sid of removed) {
    // An agent that fails to close must not keep the session around.
    try {
      endChatAgent(sid, env);
    } catch (e) {
      console.warn("closing a deleted session's agent failed", e);
    }
  }
  if (env.activeId && removed.includes(env.activeId)) env.setActiveId(null);
  env.setChats((prev) =>
    prev.filter((c) => !removed.includes(c.id)).map((c) => (c.parentId === id ? { ...c, parentId: newParent } : c)),
  );
  try {
    await deleting;
  } finally {
    env.refreshSessions();
  }
}

/** A session's chat with its messages: the one in memory when it's loaded, else read from disk. */
async function chatOf(id: string, ws: string, env: SessionActionsEnv): Promise<Chat | null> {
  const live = env.liveChats().find((c) => c.id === id);
  if (live && env.hydrated.has(id)) return live;
  return readSession(ws, id);
}

/** A copy of a whole session, saved next to it; where it is, for the caller to open. */
export async function forkSession(id: string, env: SessionActionsEnv): Promise<{ id: string; workspace: string } | null> {
  const ws = workspaceOf(id, env);
  if (!ws) return null;
  const chat = await chatOf(id, ws, env);
  const last = chat?.messages.at(-1);
  if (!chat || !last) return null;
  const fork = forkChat({ ...chat, workspace: ws }, last.id, newChatId(env.liveChats()), `${chat.title} (${env.t.chatUi.forkSuffix})`);
  if (!fork) return null;
  await saveSession(ws, fork, Date.now());
  env.refreshSessions();
  return { id: fork.id, workspace: ws };
}

/**
 * Moves a session to another project: saved there under a new id, then deleted here (a deleted
 * id stays deleted, so it can't be reused). Its worktree, file-history backups and nesting belong
 * to the old project and stay behind; a Claude Code session started there starts afresh with the
 * whole conversation. Its sidebar marks go with it.
 */
export async function moveSession(id: string, to: string, env: SessionActionsEnv): Promise<{ id: string; workspace: string; wasActive: boolean } | null> {
  const from = workspaceOf(id, env);
  if (!from || from === to || env.streaming(id)) return null;
  const chat = await chatOf(id, from, env);
  if (!chat) return null;
  const newId = newChatId(env.liveChats());
  const moved: Chat = { ...chat, id: newId, workspace: to, worktree: undefined, fileHistory: undefined, parentId: undefined };
  await saveSession(to, moved, Date.now());
  carryMarks(id, newId);
  const wasActive = env.activeId === id;
  await deleteSession(id, false, env);
  return { id: newId, workspace: to, wasActive };
}

/** What "Copy ▸" in a session's menu puts on the clipboard; null when the session has none. */
export async function sessionCopyText(id: string, what: SessionCopy, env: SessionActionsEnv): Promise<string | null> {
  const session = env.sessions.find((s) => s.id === id);
  const live = env.liveChats().find((c) => c.id === id);
  const ws = workspaceOf(id, env);
  if (what === "id") return session ? id : null;
  // Where its turns run: its worktree when it has one.
  if (what === "dir") return live?.worktree?.path ?? session?.worktree?.path ?? ws;
  const chat = ws ? await chatOf(id, ws, env) : (live ?? null);
  if (!chat) return null;
  const tm = env.t.sidebarMenu;
  const labels = { user: tm.mdUser, assistant: tm.mdAssistant, handoffIntro: tm.handoffIntro, handoffProject: tm.handoffProject };
  return what === "markdown"
    ? sessionMarkdown(chat.title, chat.messages, labels)
    : sessionHandoff(chat.title, chat.worktree?.path ?? ws, chat.messages, labels);
}

/** A new session with the open chat's conversation up to `messageId`, opened and saved. */
export function forkOpenChat(messageId: string, env: SessionActionsEnv): void {
  const chats = env.liveChats();
  const chat = chats.find((c) => c.id === env.activeId);
  const fork = chat && forkChat(chat, messageId, newChatId(chats), `${chat.title} (${env.t.chatUi.forkSuffix})`);
  if (!chat || !fork) return;
  env.hydrated.add(fork.id);
  env.setChats((prev) => [fork, ...prev]);
  env.setActiveId(fork.id);
  const ws = chat.workspace ?? env.workspace;
  if (ws) void saveSession(ws, fork, Date.now()).then(env.refreshSessions);
}
