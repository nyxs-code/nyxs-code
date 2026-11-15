import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/components/Message";
import { chatIndexJson, loadChatIndex, loadChatMessages, saveChatFile, saveChatIndex, type Chat } from "@/lib/chatStore";
import {
  deserializeFileHistory,
  emptyFileHistoryState,
  serializeFileHistory,
  type FileHistoryState,
  type SerializedFileHistory,
} from "@/lib/fileHistory";
import { loadWorkspace } from "@/lib/workspace";

const SAVE_DELAY_MS = 800;
const MAX_SAVE_WAIT_MS = 5000;

/** The chats in memory and the open one, saved to disk as they change. A chat's messages are
 *  loaded from disk only when first needed (`ensureHydrated`); until then only its entry in
 *  the index is in memory. Also keeps each chat's file history, which says which messages can
 *  be reverted. */
export function useChatStore() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The latest values, for async code and stable callbacks.
  const liveChatsRef = useRef(chats);
  const liveActiveIdRef = useRef(activeId);
  useLayoutEffect(() => {
    liveChatsRef.current = chats;
    liveActiveIdRef.current = activeId;
  });

  const patchMessage = useCallback((chatId: string, msgId: string, fn: (m: ChatMessage) => ChatMessage) => {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) } : c)),
    );
  }, []);

  const fhRef = useRef<Map<string, FileHistoryState>>(new Map());
  const [restorableMsgIds, setRestorableMsgIds] = useState<Set<string>>(() => new Set());
  const updateFileHistory = useCallback(
    (chatId: string, updater: (prev: FileHistoryState) => FileHistoryState) => {
      const prev = fhRef.current.get(chatId) ?? emptyFileHistoryState();
      const next = updater(prev);
      if (next === prev) return;
      fhRef.current.set(chatId, next);

      const ids = new Set<string>();
      for (const state of fhRef.current.values()) {
        for (const snap of state.snapshots) ids.add(snap.messageId);
      }
      setRestorableMsgIds(ids);
    },
    [],
  );
  const fhUpdater = useCallback(
    (chatId: string) => (updater: (prev: FileHistoryState) => FileHistoryState) => updateFileHistory(chatId, updater),
    [updateFileHistory],
  );
  /** Takes in the file history saved with a chat read from disk. */
  const adoptFileHistory = useCallback((chatId: string, saved: SerializedFileHistory) => {
    const state = deserializeFileHistory(saved);
    fhRef.current.set(chatId, state);
    if (!state.snapshots.length) return;
    setRestorableMsgIds((prev) => {
      const next = new Set(prev);
      for (const s of state.snapshots) next.add(s.messageId);
      return next;
    });
  }, []);
  const withFileHistory = useCallback(
    (cs: Chat[]): Chat[] =>
      cs.map((c) => {
        const fh = fhRef.current.get(c.id);
        return fh ? { ...c, fileHistory: serializeFileHistory(fh) } : c;
      }),
    [],
  );

  // Chats whose messages are in memory. A chat created in this run is, from the start.
  const hydratedRef = useRef<Set<string>>(new Set());
  const hydratingRef = useRef<Map<string, Promise<ChatMessage[]>>>(new Map());
  const ensureHydrated = useCallback((id: string): Promise<ChatMessage[]> => {
    if (hydratedRef.current.has(id)) {
      const c = liveChatsRef.current.find((x) => x.id === id);
      return Promise.resolve(c?.messages ?? []);
    }
    const existing = hydratingRef.current.get(id);
    if (existing) return existing;
    const p = (async () => {
      try {
        const { messages, fileHistory, failed } = await loadChatMessages(id);
        // Left unhydrated, its file isn't saved over with no messages; the next open retries.
        if (failed) return [];
        if (fileHistory) adoptFileHistory(id, fileHistory);
        setChats((prev) => prev.map((c) => (c.id === id ? { ...c, messages, fileHistory } : c)));
        hydratedRef.current.add(id);
        return messages;
      } finally {
        hydratingRef.current.delete(id);
      }
    })();
    hydratingRef.current.set(id, p);
    return p;
  }, [adoptFileHistory]);

  // The saved chats, and the open one if it belongs to the open folder.
  const [chatsReady, setChatsReady] = useState(false);
  // The index on disk couldn't be read: this run doesn't save one, or the list would be lost.
  const indexLoadFailedRef = useRef(false);
  useEffect(() => {
    (async () => {
      const { chats: saved, activeId: savedActive, failed } = await loadChatIndex();
      if (failed) indexLoadFailedRef.current = true;
      if (saved.length) {
        setChats(saved);
        const ws = loadWorkspace();
        const active = savedActive ? saved.find((c) => c.id === savedActive) : undefined;
        if (active && (active.workspace ?? null) === (ws ?? null)) {
          setActiveId(savedActive);
          await ensureHydrated(savedActive!);
        }
      }
      setChatsReady(true);
    })();
  }, [ensureHydrated]);

  // What was last sent to disk: a chat (the object and its file history, both replaced on every
  // change) and the index. Writing every loaded chat on each change rewrote them all.
  const savedChatsRef = useRef<Map<string, { chat: Chat; fh: FileHistoryState | undefined }>>(new Map());
  const savedIndexRef = useRef<string | null>(null);
  const persistChats = useCallback(
    (cs: Chat[], aid: string | null) => {
      if (!indexLoadFailedRef.current) {
        const json = chatIndexJson(cs, aid);
        if (json !== savedIndexRef.current) {
          savedIndexRef.current = json;
          void saveChatIndex(cs, aid, json).then((ok) => {
            if (!ok && savedIndexRef.current === json) savedIndexRef.current = null;
          });
        }
      }
      for (const c of cs) {
        if (!hydratedRef.current.has(c.id)) continue;
        const fh = fhRef.current.get(c.id);
        const last = savedChatsRef.current.get(c.id);
        if (last && last.chat === c && last.fh === fh) continue;
        const sent = { chat: c, fh };
        savedChatsRef.current.set(c.id, sent);
        // A write that failed is tried again on the next save.
        void saveChatFile(withFileHistory([c])[0]).then((ok) => {
          if (!ok && savedChatsRef.current.get(c.id) === sent) savedChatsRef.current.delete(c.id);
        });
      }
    },
    [withFileHistory],
  );
  // Saved once changes stop for a moment, and at least every few seconds while they don't: each
  // chunk of a reply is a change, and a long one put the save off until it ended.
  const pendingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!chatsReady) return;
    const now = Date.now();
    pendingSinceRef.current ??= now;
    const wait = Math.max(0, Math.min(SAVE_DELAY_MS, pendingSinceRef.current + MAX_SAVE_WAIT_MS - now));
    const t = setTimeout(() => {
      pendingSinceRef.current = null;
      persistChats(liveChatsRef.current, liveActiveIdRef.current);
    }, wait);
    return () => clearTimeout(t);
  }, [chatsReady, chats, activeId, restorableMsgIds, persistChats]);
  const chatsReadyRef = useRef(chatsReady);
  useLayoutEffect(() => { chatsReadyRef.current = chatsReady; }, [chatsReady]);
  useEffect(() => {
    const flush = () => {
      if (!chatsReadyRef.current) return;
      persistChats(liveChatsRef.current, liveActiveIdRef.current);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [persistChats]);

  return {
    chats,
    setChats,
    activeId,
    setActiveId,
    liveChatsRef,
    liveActiveIdRef,
    patchMessage,
    chatsReady,
    hydratedRef,
    ensureHydrated,
    fhRef,
    restorableMsgIds,
    fhUpdater,
    adoptFileHistory,
    withFileHistory,
  };
}
