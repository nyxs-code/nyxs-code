import { invoke } from "@/lib/ipc";
import { generateUniqueWordSlug } from "@/lib/words";
import { descendantsOf } from "@/lib/sessionTree";
import type { SessionPrLink } from "@/lib/sessionPrLinks";
import type { Chat } from "@/lib/chatStore";
import { showFileNotice } from "@/lib/fileNotices";
import { withoutOldToolImages } from "@/lib/toolImageHistory";
import type { ChatMessage } from "@/components/Message";
import {
  deserializeFileHistory,
  fileHistoryCanRestore,
  fileHistoryRewind,
  type SerializedFileHistory,
  type UpdateFileHistory,
} from "@/lib/fileHistory";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface SessionMeta {
  title: string;
  contextTokens?: number;
  plan?: string;
  summary?: string;
  compactedUpTo?: number;
  compactions?: Chat["compactions"];
  fileHistory?: Chat["fileHistory"];
  model?: string;
  permissionMode?: Chat["permissionMode"];
  worktree?: Chat["worktree"];
  environmentId?: string;
  parentId?: string;
  effort?: Chat["effort"];
  goal?: Chat["goal"];
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
  archivedAt?: number;
  /** The PRs the session opened, read by their URL (see sessionPrLinks). */
  prs?: SessionPrLink[];
  /** Before `prs`: the branch the session pushed, which `gh pr list --head` finds its PR by. Still
   *  read as a link by branch; new links never write it. A PR number or URL here is a link from
   *  0.8.28 to a merged PR and is ignored (see isMergedPrLink). */
  prBranch?: string;
  /** The session itself pushed `prBranch` (or opened its PR). Older sessions recorded the
   *  branch they merely ran on, so without this their PR link has to be double-checked. */
  prPushed?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  gitBranch?: string;
  workspace?: string;
  archived?: boolean;
  archivedAt?: number;
  prs?: SessionPrLink[];
  prBranch?: string;
  prPushed?: boolean;
  worktree?: Chat["worktree"];
  /** The session that started this one (see Chat.parentId). */
  parentId?: string;
}

/** Sessions deleted while the app runs. A save already on its way when the delete ran (the
 *  autosave timer, the last save of a stopped turn, a title arriving late) must not write the
 *  files back, and a listing read before the delete must not show the row again. */
const deletedSessions = new Set<string>();

export function isDeletedSession(sessionId: string): boolean {
  return deletedSessions.has(sessionId);
}

export function newSessionId(existing: Iterable<string> = []): string {
  return generateUniqueWordSlug(new Set([...existing, ...deletedSessions]));
}

function persistable(message: ChatMessage): ChatMessage {
  const { streaming: _streaming, ...rest } = message as ChatMessage & { streaming?: boolean };
  return rest as ChatMessage;
}

export async function appendMessage(
  workspace: string | null,
  sessionId: string,
  message: ChatMessage,
): Promise<void> {
  if (!isTauri || !workspace || deletedSessions.has(sessionId)) return;
  await invoke("nyxs_session_append", {
    workspace,
    sessionId,
    line: JSON.stringify(persistable(message)),
  });
}

export async function saveSessionMeta(
  workspace: string | null,
  sessionId: string,
  meta: SessionMeta,
): Promise<void> {
  if (!isTauri || !workspace || deletedSessions.has(sessionId)) return;
  await invoke("nyxs_session_write_meta", {
    workspace,
    sessionId,
    json: JSON.stringify(meta, null, 2),
  });
}

const metaLocks = new Map<string, Promise<unknown>>();

/** Read-modify-writes of one session's meta run one at a time: a chat save that read the meta
 *  just before a PR link was written would otherwise write the old meta back and drop the link. */
function withMetaLock<T>(workspace: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${workspace}\n${sessionId}`;
  const next = (metaLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => undefined);
  metaLocks.set(key, tail);
  void tail.then(() => {
    if (metaLocks.get(key) === tail) metaLocks.delete(key);
  });
  return next;
}

export async function renameSession(
  workspace: string | null,
  sessionId: string,
  title: string,
): Promise<void> {
  if (!workspace) return;
  await withMetaLock(workspace, sessionId, async () => {
    const meta = await readSessionMeta(workspace, sessionId);
    if (!meta) return;
    await saveSessionMeta(workspace, sessionId, { ...meta, title: title.trim() });
  });
}

function metaFromChat(chat: Chat, createdAt: number, now: number): SessionMeta {
  return {
    title: chat.title,
    contextTokens: chat.contextTokens,
    plan: chat.plan,
    summary: chat.summary,
    compactedUpTo: chat.compactedUpTo,
    compactions: chat.compactions,
    fileHistory: chat.fileHistory,
    model: chat.model,
    permissionMode: chat.permissionMode,
    worktree: chat.worktree,
    environmentId: chat.environmentId,
    parentId: chat.parentId,
    effort: chat.effort,
    goal: chat.goal,
    createdAt,
    updatedAt: now,
  };
}

export async function saveSession(
  workspace: string | null,
  chat: Chat,
  now: number,
): Promise<void> {
  if (!isTauri || !workspace || deletedSessions.has(chat.id)) return;
  const messages = withoutOldToolImages(chat.messages);
  const content = messages.map((m) => JSON.stringify(persistable(m))).join("\n") + (messages.length ? "\n" : "");

  // The transcript is written under the lock too, so a delete queued behind it removes it and a
  // save queued behind a delete writes nothing.
  await withMetaLock(workspace, chat.id, async () => {
    if (deletedSessions.has(chat.id)) return;
    await invoke("nyxs_session_write_transcript", { workspace, sessionId: chat.id, content });
    const read = await readSessionMetaChecked(workspace, chat.id);
    if (read.status === "unreadable") {
      // Writing a fresh meta would drop its archived state, PR links and creation date.
      console.warn(`[sessions] meta of ${chat.id} couldn't be read, not saving over it: ${read.error}`);
      return;
    }
    const existing = read.status === "ok" ? read.meta : null;
    await saveSessionMeta(workspace, chat.id, {
      ...metaFromChat(chat, existing?.createdAt ?? now, now),
      archived: existing?.archived,
      archivedAt: existing?.archivedAt,
      prs: existing?.prs,
      prBranch: existing?.prBranch,
      prPushed: existing?.prPushed,
    });
  });
}

export async function setSessionArchived(
  workspace: string | null,
  sessionId: string,
  archived: boolean,
  archivedAt = 0,
): Promise<void> {
  if (!workspace) return;
  await withMetaLock(workspace, sessionId, async () => {
    const meta = await readSessionMeta(workspace, sessionId);
    if (!meta) return;
    await saveSessionMeta(workspace, sessionId, {
      ...meta,
      archived,
      archivedAt: archived ? archivedAt || meta.archivedAt : undefined,
    });
  });
}

export async function setSessionPrBranch(
  workspace: string | null,
  sessionId: string,
  branch: string,
): Promise<void> {
  if (!workspace || !branch) return;
  await withMetaLock(workspace, sessionId, async () => {
    const meta = await readSessionMeta(workspace, sessionId);
    if (!meta || (meta.prBranch === branch && meta.prPushed)) return;
    await saveSessionMeta(workspace, sessionId, { ...meta, prBranch: branch, prPushed: true });
  });
}

/** Rewrites the session's PR list (see sessionPrLinks.linkSessionPr). Nothing is written when
 *  `update` leaves it as it was. */
export async function updateSessionPrLinks(
  workspace: string | null,
  sessionId: string,
  update: (prs: SessionPrLink[]) => SessionPrLink[],
): Promise<void> {
  if (!workspace) return;
  await withMetaLock(workspace, sessionId, async () => {
    const meta = await readSessionMeta(workspace, sessionId);
    if (!meta) return;
    const prs = update(meta.prs ?? []);
    if (JSON.stringify(prs) === JSON.stringify(meta.prs ?? [])) return;
    await saveSessionMeta(workspace, sessionId, { ...meta, prs });
  });
}

export interface SessionPrState {
  createdAt: number;
  prs: SessionPrLink[];
  /** The old-style link by branch, when the session has one it recorded itself. */
  legacyBranch: string | null;
}

/** What the session is linked to: its PRs and an old-style branch link. */
export async function sessionPrState(workspace: string | null, sessionId: string): Promise<SessionPrState | null> {
  if (!workspace) return null;
  const meta = await readSessionMeta(workspace, sessionId).catch(() => null);
  if (!meta) return null;
  return {
    createdAt: meta.createdAt,
    prs: meta.prs ?? [],
    legacyBranch: meta.prPushed && meta.prBranch ? meta.prBranch : null,
  };
}

/** Moves a session under another one (CreateSession's parent), or to the top level. */
export async function setSessionParent(
  workspace: string | null,
  sessionId: string,
  parentId: string | undefined,
): Promise<void> {
  if (!workspace) return;
  await withMetaLock(workspace, sessionId, async () => {
    const meta = await readSessionMeta(workspace, sessionId);
    if (!meta || meta.parentId === parentId) return;
    await saveSessionMeta(workspace, sessionId, { ...meta, parentId });
  });
}

/** The files a saved session edited (its file history), absolute paths. */
export async function sessionTrackedFiles(workspace: string, sessionId: string): Promise<string[]> {
  const meta = await readSessionMeta(workspace, sessionId).catch(() => null);
  return meta?.fileHistory?.trackedFiles ?? [];
}

type MetaRead =
  | { status: "missing" }
  | { status: "ok"; meta: SessionMeta }
  | { status: "unreadable"; error: string };

/** What `nyxs_session_read` answers. With `error` set, both files are empty and aren't the session. */
interface SessionFiles {
  transcript: string;
  meta: string;
  error?: string | null;
  /** The session's folder on this PC (none for a remote project). */
  dir?: string | null;
}

async function readSessionMetaChecked(workspace: string, sessionId: string): Promise<MetaRead> {
  let meta: string;
  try {
    // Only the meta: the whole transcript came over IPC with it on every save and rename.
    const read = await invoke<SessionFiles>("nyxs_session_read_meta", { workspace, sessionId });
    if (read.error) return { status: "unreadable", error: read.error };
    meta = read.meta;
  } catch (e) {
    return { status: "unreadable", error: String(e) };
  }
  if (!meta.trim()) return { status: "missing" };
  try {
    const parsed = JSON.parse(meta) as SessionMeta | null;
    if (!parsed || typeof parsed !== "object") return { status: "unreadable", error: "not a JSON object" };
    return { status: "ok", meta: parsed };
  } catch (e) {
    return { status: "unreadable", error: String(e) };
  }
}

/** The session's meta, or null when it has none or it couldn't be read: either way, callers
 *  that edit it leave it alone. */
async function readSessionMeta(
  workspace: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const read = await readSessionMetaChecked(workspace, sessionId);
  return read.status === "ok" ? read.meta : null;
}

/** Throws, and tells the user, when the session's files are there but couldn't be read, rather
 *  than answering with an empty session that the next save would write over the real one. */
export async function readSession(
  workspace: string | null,
  sessionId: string,
): Promise<Chat | null> {
  if (!isTauri || !workspace) return null;
  let read: SessionFiles;
  try {
    read = await invoke<SessionFiles>("nyxs_session_read", { workspace, sessionId });
  } catch (e) {
    showFileNotice({ kind: "unreadableSession", folder: null });
    throw e;
  }
  if (read.error) {
    showFileNotice({ kind: "unreadableSession", folder: read.dir ?? null });
    throw new Error(read.error);
  }
  const { transcript, meta } = read;
  if (!transcript.trim() && !meta.trim()) return null;

  const messages: ChatMessage[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      messages.push({ ...(JSON.parse(line) as ChatMessage), streaming: false });
    } catch {
      // Skip a corrupt line rather than losing the whole transcript.
    }
  }

  let m: SessionMeta | null = null;
  if (meta.trim()) {
    try {
      m = JSON.parse(meta) as SessionMeta;
    } catch {
      m = null;
    }
  }

  return {
    id: sessionId,
    title: m?.title ?? "",
    messages,
    contextTokens: m?.contextTokens,
    plan: m?.plan,
    summary: m?.summary,
    compactedUpTo: m?.compactedUpTo,
    compactions: m?.compactions,
    fileHistory: m?.fileHistory,
    model: m?.model,
    permissionMode: m?.permissionMode,
    worktree: m?.worktree,
    environmentId: m?.environmentId,
    parentId: m?.parentId,
    effort: m?.effort,
    goal: m?.goal,
  };
}

export async function listSessions(workspace: string | null): Promise<SessionSummary[]> {
  if (!isTauri || !workspace) return [];
  interface RawSummary {
    id: string;
    meta: string;
    modifiedAt: number;
    messageCount: number;
    gitBranch?: string | null;
  }
  let raw: RawSummary[];
  try {
    raw = await invoke<RawSummary[]>("nyxs_list_sessions", { workspace });
  } catch {
    return [];
  }
  return raw.map((s) => {
    let title = "";
    let createdAt = s.modifiedAt;
    let archived = false;
    let prs: SessionPrLink[] | undefined;
    let prBranch: string | undefined;
    let prPushed = false;
    let archivedAt: number | undefined;
    let worktree: Chat["worktree"];
    let parentId: string | undefined;
    if (s.meta) {
      try {
        const m = JSON.parse(s.meta) as Partial<SessionMeta>;
        title = m.title ?? "";
        createdAt = m.createdAt ?? s.modifiedAt;
        archived = m.archived === true;
        prs = Array.isArray(m.prs) && m.prs.length ? m.prs : undefined;
        prBranch = m.prBranch;
        prPushed = m.prPushed === true;
        archivedAt = m.archivedAt;
        worktree = m.worktree;
        parentId = m.parentId;
      } catch {
        /* keep fallbacks */
      }
    }
    return {
      id: s.id,
      title,
      createdAt,
      modifiedAt: s.modifiedAt,
      messageCount: s.messageCount,
      gitBranch: s.gitBranch ?? undefined,
      archived,
      prs,
      prBranch,
      prPushed,
      archivedAt,
      worktree,
      parentId,
    };
  });
}

/** The sessions of these folders, the active and the archived apart, newest first. Each folder
 *  is listed once: asking for the two lists separately listed every folder twice. */
export async function listSessionsByState(
  workspaces: Iterable<string | null>,
): Promise<{ active: SessionSummary[]; archived: SessionSummary[] }> {
  const unique = Array.from(new Set(Array.from(workspaces).filter((w): w is string => !!w)));
  const lists = await Promise.all(
    unique.map(async (ws) => (await listSessions(ws)).map((s) => ({ ...s, workspace: ws }))),
  );
  const all = lists
    .flat()
    .filter((s) => !deletedSessions.has(s.id))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { active: all.filter((s) => !s.archived), archived: all.filter((s) => s.archived) };
}

export async function deleteSession(
  workspace: string | null,
  sessionId: string,
): Promise<void> {
  deletedSessions.add(sessionId);
  if (!isTauri || !workspace) return;
  await withMetaLock(workspace, sessionId, () => invoke("nyxs_session_delete", { workspace, sessionId }));
}

/** The session and, with `withNested`, every session nested under it. */
export function sessionFamilyIds(id: string, withNested: boolean, sessions: SessionSummary[]): string[] {
  return withNested ? [id, ...descendantsOf(id, sessions).map((s) => s.id)] : [id];
}

/** Deletes a session and, with `withNested`, every session nested under it. Otherwise its
 *  children move up to its own parent (or the top level). Returns what was deleted. */
export async function deleteSessionFamily(
  id: string,
  withNested: boolean,
  sessions: SessionSummary[],
  fallbackWorkspace: string | null,
): Promise<{ removed: string[]; newParent: string | undefined }> {
  const wsOf = (sid: string) => sessions.find((s) => s.id === sid)?.workspace ?? fallbackWorkspace;
  const newParent = sessions.find((s) => s.id === id)?.parentId;
  const removed = sessionFamilyIds(id, withNested, sessions);
  for (const sid of removed) deletedSessions.add(sid);
  if (!withNested) {
    for (const child of sessions.filter((s) => s.parentId === id)) {
      await setSessionParent(wsOf(child.id), child.id, newParent).catch(() => undefined);
    }
  }
  for (const sid of removed) await deleteSession(wsOf(sid), sid);
  return { removed, newParent };
}

export interface RewindPoint {
  messageId: string;
  index: number;
  fileCount: number;
}

export function canRewindSession(
  fileHistory: SerializedFileHistory | null | undefined,
): boolean {
  return (
    (fileHistory?.snapshots?.length ?? 0) > 0 && (fileHistory?.trackedFiles?.length ?? 0) > 0
  );
}

export function sessionRewindPoints(
  fileHistory: SerializedFileHistory | null | undefined,
): RewindPoint[] {
  const state = deserializeFileHistory(fileHistory ?? null);
  return state.snapshots.map((snap, index) => ({
    messageId: snap.messageId,
    index,
    fileCount: Object.keys(snap.trackedFileBackups).length,
  }));
}

export async function rewindSessionFiles(
  workspace: string | null,
  sessionId: string,
  fileHistory: SerializedFileHistory | null | undefined,
  toMessageId?: string,
): Promise<{ changed: number; kept: string[]; failed?: string[]; messageId: string } | null> {
  if (!isTauri || !workspace) return null;

  let state = deserializeFileHistory(fileHistory ?? null);
  if (state.snapshots.length === 0 || state.trackedFiles.size === 0) return null;

  const messageId = toMessageId ?? state.snapshots[0].messageId;
  if (!fileHistoryCanRestore(state, messageId)) return null;

  const update: UpdateFileHistory = (updater) => {
    state = updater(state);
  };

  // A worktree session's turns ran, and kept their backups and snapshots, in its worktree.
  const dir = (await readSessionMeta(workspace, sessionId).catch(() => null))?.worktree?.path ?? workspace;
  const { changed, kept, failed } = await fileHistoryRewind(update, dir, sessionId, messageId);
  if (failed?.length) showFileNotice({ kind: "rewindFailed", files: failed });
  return { changed, kept, ...(failed ? { failed } : {}), messageId };
}
