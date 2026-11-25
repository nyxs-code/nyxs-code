import { invoke } from "@/lib/ipc";
import { folderOf, showFileNotice } from "@/lib/fileNotices";
import { withoutOldToolImages } from "@/lib/toolImageHistory";
import type { ChatMessage } from "@/components/Message";
import type { SerializedFileHistory } from "@/lib/fileHistory";
import type { PermissionMode } from "@/components/ui/claude-style-chat-input";
import type { EffortLevel } from "@/lib/effort";
import type { ChatGoal } from "@/lib/goal";

export interface Chat {
  id: string;
  title: string;
  workspace?: string | null;
  model?: string;
  permissionMode?: PermissionMode;
  messages: ChatMessage[];
  contextTokens?: number;
  plan?: string;
  summary?: string;
  compactedUpTo?: number;
  /** Each compaction that finished (`/compact`, or Nyxs' or Claude Code's automatic one mid-turn),
   *  drawn as a divider in the conversation. */
  compactions?: CompactionMark[];
  fileHistory?: SerializedFileHistory;
  /** The session works in its own git worktree, like Claude Code Desktop's Worktree switch:
   *  the agent, terminal, diff and PR bar use `path`, while the session stays listed (and
   *  saved) under its project, `workspace`. */
  worktree?: SessionWorktree;
  /** The saved environment the session started from: its turns get that environment's variables. */
  environmentId?: string;
  /** The session whose agent created this one (CreateSession): Recents nests it under that one. */
  parentId?: string;
  /** The effort its agent-started turns run at (CreateSession picks it); the app's otherwise. */
  effort?: EffortLevel;
  /** The goal set with `/goal`: the agent keeps working, turn after turn, until it is met. */
  goal?: ChatGoal;
}

export interface CompactionMark {
  /** The message the divider follows. Tied to an id, not an index, so a rewind or an edit
   *  that removes that message takes its divider along. */
  afterId: string;
  /** How long it took. */
  ms: number;
  /** The context before and after, when known. */
  beforeTokens?: number;
  afterTokens?: number;
}

export interface SessionWorktree {
  path: string;
  branch: string;
}

interface PersistedState {
  version: 1;
  activeId: string | null;
  chats: Chat[];
}

type ChatMeta = Omit<Chat, "messages" | "fileHistory">;

interface IndexState {
  version: 2;
  activeId: string | null;
  chats: ChatMeta[];
  /** Set by the backend instead of the list when the index was corrupt: where it was moved. */
  setAside?: string;
}

interface ChatFile {
  messages: ChatMessage[];
  fileHistory?: SerializedFileHistory;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function metaOf(c: Chat): ChatMeta {
  const { messages: _m, fileHistory: _f, ...meta } = c;
  return meta;
}

/** `failed`: the file is there but couldn't be read, so saving over it would lose it. */
export interface LoadedChats {
  chats: Chat[];
  activeId: string | null;
  failed?: boolean;
}

export async function loadChats(): Promise<LoadedChats> {
  if (!isTauri) return { chats: [], activeId: null };
  try {
    const raw = await invoke<string>("nyxs_load_chats");
    if (!raw) return { chats: [], activeId: null };
    const parsed = JSON.parse(raw) as PersistedState | null;
    const chats = (parsed?.chats ?? []).map((c) => ({
      ...c,
      messages: (c.messages ?? []).map((m) => ({ ...m, streaming: false })),
    }));
    return { chats, activeId: parsed?.activeId ?? null };
  } catch (e) {
    console.error("No se pudieron cargar los chats", e);
    return { chats: [], activeId: null, failed: true };
  }
}

/** With `failed` set, the index must not be saved this run: it would replace the real list. */
export async function loadChatIndex(): Promise<LoadedChats> {
  if (!isTauri) return { chats: [], activeId: null };
  try {
    const raw = await invoke<string>("nyxs_load_chat_index");
    if (raw) {
      const parsed = JSON.parse(raw) as IndexState | null;
      if (parsed?.setAside) {
        showFileNotice({ kind: "chatIndexSetAside", file: parsed.setAside, folder: folderOf(parsed.setAside) });
      }
      const chats = (parsed?.chats ?? []).map((m) => ({ ...m, messages: [] as ChatMessage[] }));
      return { chats, activeId: parsed?.activeId ?? null };
    }
    return await migrateLegacyToIndex();
  } catch (e) {
    console.error("No se pudo cargar el índice de chats", e);
    return { chats: [], activeId: null, failed: true };
  }
}

async function migrateLegacyToIndex(): Promise<LoadedChats> {
  const legacy = await loadChats();
  if (legacy.failed) return legacy;
  if (!legacy.chats.length) {
    await saveChatIndex([], null);
    return { chats: [], activeId: null };
  }
  for (const c of legacy.chats) await saveChatFile(c);
  await saveChatIndex(legacy.chats, legacy.activeId);
  const chats = legacy.chats.map((c) => ({ ...c, messages: [] as ChatMessage[], fileHistory: undefined }));
  return { chats, activeId: legacy.activeId };
}

/** With `failed` set, the chat's file is still on disk unread: it must not be saved over. */
export async function loadChatMessages(
  id: string,
): Promise<{ messages: ChatMessage[]; fileHistory?: SerializedFileHistory; failed?: boolean }> {
  if (!isTauri) return { messages: [] };
  try {
    const raw = await invoke<string>("nyxs_load_chat", { id });
    if (!raw) return { messages: [] };
    const parsed = JSON.parse(raw) as ChatFile | null;
    return {
      messages: (parsed?.messages ?? []).map((m) => ({ ...m, streaming: false })),
      fileHistory: parsed?.fileHistory,
    };
  } catch (e) {
    console.error(`No se pudo cargar el chat ${id}`, e);
    return { messages: [], failed: true };
  }
}

const writeQueues = new Map<string, Promise<unknown>>();

/** Runs the writes of one file one after another. The backend runs them on worker threads, where
 *  two sent together could finish in either order and leave the older content on disk. */
function queued<T>(file: string, write: () => Promise<T>): Promise<T> {
  const next = (writeQueues.get(file) ?? Promise.resolve()).then(write, write);
  const tail = next.catch(() => undefined);
  writeQueues.set(file, tail);
  void tail.then(() => {
    if (writeQueues.get(file) === tail) writeQueues.delete(file);
  });
  return next;
}

/** Whether the chat's file was written. */
export async function saveChatFile(chat: Chat): Promise<boolean> {
  if (!isTauri) return true;
  const file: ChatFile = { messages: withoutOldToolImages(chat.messages), fileHistory: chat.fileHistory };
  const json = JSON.stringify(file);
  return queued(`chat ${chat.id}`, async () => {
    try {
      await invoke("nyxs_save_chat", { id: chat.id, json });
      return true;
    } catch (e) {
      console.error(`No se pudo guardar el chat ${chat.id}`, e);
      return false;
    }
  });
}

/** The index as `saveChatIndex` writes it, so a caller can tell when it hasn't changed. */
export function chatIndexJson(chats: Chat[], activeId: string | null): string {
  const state: IndexState = { version: 2, activeId, chats: chats.map(metaOf) };
  return JSON.stringify(state);
}

/** Whether the index was written. */
export async function saveChatIndex(chats: Chat[], activeId: string | null, json = chatIndexJson(chats, activeId)): Promise<boolean> {
  if (!isTauri) return true;
  return queued("index", async () => {
    try {
      await invoke("nyxs_save_chat_index", { json });
      return true;
    } catch (e) {
      console.error("No se pudo guardar el índice de chats", e);
      return false;
    }
  });
}

export async function deleteChatFile(id: string): Promise<void> {
  if (!isTauri) return;
  // Behind the chat's pending saves, or one of them would write the file back.
  await queued(`chat ${id}`, async () => {
    try {
      await invoke("nyxs_delete_chat", { id });
    } catch (e) {
      console.error(`No se pudo borrar el chat ${id}`, e);
    }
  });
}
