import { useEffect, useRef } from "react";
import type { Chat } from "@/lib/chatStore";
import { saveSession } from "@/lib/sessionStorage";

const SAVE_DELAY_MS = 900;
const MAX_SAVE_WAIT_MS = 5000;

/** Chats exactly as they were read from disk. */
const asOnDisk = new WeakSet<Chat>();

/** Marks a chat just read from its session as already saved: opening a session used to write
 *  it back unchanged, which moved it to the top of Recents as "now" and could write a session
 *  being deleted back to disk. */
export function markChatAsOnDisk(chat: Chat): void {
  asOnDisk.add(chat);
}

/** Saves the open chat as its project's session a moment after it changes, and at least every
 *  few seconds while it keeps changing: each chunk of a reply is a change, and a long one put the
 *  save off until it ended. */
export function useSessionAutosave({
  ready,
  workspace,
  activeChat,
  restorableMsgIds,
  withFileHistory,
  onSaved,
}: {
  ready: boolean;
  workspace: string | null;
  activeChat: Chat | null;
  /** Only a dependency: a new restore point changes what's saved with the chat. */
  restorableMsgIds: Set<string>;
  withFileHistory: (cs: Chat[]) => Chat[];
  onSaved: () => void;
}) {
  const pendingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !ready ||
      !workspace ||
      !activeChat?.messages.length ||
      (activeChat.workspace ?? null) !== workspace ||
      asOnDisk.has(activeChat)
    ) {
      pendingSinceRef.current = null;
      return;
    }
    const chat = withFileHistory([activeChat])[0];
    const now = Date.now();
    pendingSinceRef.current ??= now;
    const wait = Math.max(0, Math.min(SAVE_DELAY_MS, pendingSinceRef.current + MAX_SAVE_WAIT_MS - now));
    const t = setTimeout(() => {
      pendingSinceRef.current = null;
      void saveSession(workspace, chat, Date.now()).then(() => onSaved());
    }, wait);
    return () => clearTimeout(t);
  }, [ready, activeChat, workspace, restorableMsgIds, withFileHistory, onSaved]);
}
