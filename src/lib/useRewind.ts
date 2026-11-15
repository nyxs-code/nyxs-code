import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Chat } from "@/lib/chatStore";
import {
  fileHistoryRewind,
  fileHistoryRewindPreview,
  type FileHistoryState,
  type RewindPreview,
  type UpdateFileHistory,
} from "@/lib/fileHistory";
import { showFileNotice } from "@/lib/fileNotices";
import type { RewindMode } from "@/components/RewindDialog";

export interface PendingRewind {
  chatId: string;
  messageId: string;
  prompt: string;
  /** What restoring the code would undo; null while it is being worked out. */
  preview: RewindPreview | null;
}

interface RewindOptions {
  activeId: string | null;
  chats: Chat[];
  setChats: Dispatch<SetStateAction<Chat[]>>;
  workspace: string | null;
  fhRef: RefObject<Map<string, FileHistoryState>>;
  fhUpdater: (chatId: string) => UpdateFileHistory;
  /** Puts the rewound prompt back in the chat box. */
  fillInputRef: RefObject<((text: string) => void) | null>;
  /** Bumped after files were restored, so the diff view reloads. */
  setDiffNonce: Dispatch<SetStateAction<number>>;
}

/** Rewinding a chat to one of its messages: the code, the conversation or both. */
export function useRewind({ activeId, chats, setChats, workspace, fhRef, fhUpdater, fillInputRef, setDiffNonce }: RewindOptions) {
  const [pendingRewind, setPendingRewind] = useState<PendingRewind | null>(null);
  // Where the chat's turns ran and kept their backups and snapshots: its worktree when it has one.
  const workDirOf = (chatId: string) => chats.find((c) => c.id === chatId)?.worktree?.path ?? workspace;

  const revertTo = (messageId: string) => {
    if (!activeId) return;
    const chatId = activeId;
    const prompt = chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId)?.content ?? "";
    setPendingRewind({ chatId, messageId, prompt, preview: null });
    const noChanges: RewindPreview = { files: 0, added: 0, removed: 0, paths: [], kept: [] };
    const fh = fhRef.current.get(chatId);
    const dir = workDirOf(chatId);
    const preview = dir && fh
      ? fileHistoryRewindPreview(fh, dir, chatId, messageId).catch(() => noChanges)
      : Promise.resolve(noChanges);
    void preview.then((p) =>
      setPendingRewind((cur) => (cur && cur.chatId === chatId && cur.messageId === messageId ? { ...cur, preview: p } : cur)),
    );
  };

  const confirmRewind = async (mode: RewindMode) => {
    if (!pendingRewind) return;
    const { chatId, messageId, prompt } = pendingRewind;
    setPendingRewind(null);
    const dir = workDirOf(chatId);
    if (mode !== "conversation" && dir) {
      try {
        const { failed } = await fileHistoryRewind(fhUpdater(chatId), dir, chatId, messageId);
        if (failed?.length) showFileNotice({ kind: "rewindFailed", files: failed });
      } catch (e) {
        console.error("No se pudieron rebobinar los cambios", e);
      }
      setDiffNonce((n) => n + 1);
    }
    if (mode === "code") return;
    setChats((prev) =>
      prev.map((c) => {
        if (c.id !== chatId) return c;
        const idx = c.messages.findIndex((m) => m.id === messageId);
        return idx < 0 ? c : { ...c, messages: c.messages.slice(0, idx) };
      }),
    );
    if (prompt) fillInputRef.current?.(prompt);
  };

  const cancelRewind = () => setPendingRewind(null);

  return { pendingRewind, revertTo, confirmRewind, cancelRewind };
}
