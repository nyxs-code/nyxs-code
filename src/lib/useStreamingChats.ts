import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCompactAborts } from "@/lib/compactAborts";

/** A turn waiting to send a failed request again: over the usage limit or after an error, and
 *  when the next try goes (epoch ms) if the agent said. */
export interface RetryState {
  rateLimited: boolean;
  at?: number;
}

/** What a running turn reports besides its stream: Claude Code compacting its own session, or
 *  waiting to send a failed request again. */
export interface TurnSide {
  compacting?: boolean;
  retrying?: RetryState;
  /** The machine Claude Code is being made ready on before the turn can start. */
  remoteSetup?: string;
}

/** Which chats have a reply running, and what each running turn reports on the side. */
export function useStreamingChats() {
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const streamingIdsRef = useRef(streamingIds);
  useEffect(() => { streamingIdsRef.current = streamingIds; }, [streamingIds]);
  const startStreaming = useCallback((id: string) => setStreamingIds((prev) => { const n = new Set(prev); n.add(id); return n; }), []);
  const stopStreaming = useCallback((id: string) => setStreamingIds((prev) => { const n = new Set(prev); n.delete(id); return n; }), []);

  /** Per chat, cleared when the turn ends. */
  const [turnSide, setTurnSide] = useState<Record<string, TurnSide>>({});
  const patchTurnSide = useCallback((chatId: string, patch: TurnSide | null) => {
    setTurnSide((prev) => {
      if (!patch) {
        if (!(chatId in prev)) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      }
      return { ...prev, [chatId]: { ...prev[chatId], ...patch } };
    });
  }, []);

  /** Chats Nyxs is summarising (`/compact` or auto-compaction mid-turn). Apart from `turnSide`
   *  because `/compact` runs outside a turn. */
  const [compactingIds, setCompactingIds] = useState<Set<string>>(new Set());
  const setCompacting = useCallback((chatId: string, on: boolean) => {
    setCompactingIds((prev) => {
      if (prev.has(chatId) === on) return prev;
      const n = new Set(prev);
      if (on) n.add(chatId);
      else n.delete(chatId);
      return n;
    });
  }, []);

  /** Chats with a reply or a compaction running, open or not: their queued messages wait. */
  const busyIds = useMemo<ReadonlySet<string>>(
    () => (compactingIds.size ? new Set([...streamingIds, ...compactingIds]) : streamingIds),
    [streamingIds, compactingIds],
  );

  /** `/compact`'s own controllers: `startCompact` goes to the command, `abortCompact` to stopping the chat. */
  const [compactAborts] = useState(createCompactAborts);
  const startCompact = useCallback((chatId: string) => compactAborts.start(chatId), [compactAborts]);
  const abortCompact = useCallback((chatId: string) => compactAborts.abort(chatId), [compactAborts]);

  return {
    streamingIds,
    streamingIdsRef,
    startStreaming,
    stopStreaming,
    turnSide,
    patchTurnSide,
    compactingIds,
    busyIds,
    setCompacting,
    startCompact,
    abortCompact,
  };
}
