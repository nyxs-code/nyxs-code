import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearQueue,
  editItem,
  enqueue,
  prioritize,
  promote,
  readyToSend,
  removeItem,
  setPaused,
  type QueueMap,
  type QueuedMessage,
} from "@/lib/messageQueue";
import type { InboxMessage, TurnInbox } from "@/lib/turnInbox";

const newId = () => Math.random().toString(36).slice(2, 11);

type Listeners = Map<string, Set<() => void>>;

function listen(map: Listeners, chatId: string, fn: () => void): () => void {
  let set = map.get(chatId);
  if (!set) map.set(chatId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) map.delete(chatId);
  };
}

function notify(map: Listeners, chatId: string) {
  for (const fn of [...(map.get(chatId) ?? [])]) fn();
}

export function useMessageQueue<P extends { message: string }>({
  activeId,
  busyIds,
  send,
  abort,
  prepare,
  release,
}: {
  activeId: string | null;
  /** The chats with a turn (or a compaction) running, open or not. */
  busyIds: ReadonlySet<string>;
  /** Sends an item to `chatId`, the chat it was queued in. */
  send: (item: QueuedMessage<P>, chatId: string) => Promise<unknown> | undefined;
  abort: (chatId: string) => void;
  prepare: (item: QueuedMessage<P>) => Promise<InboxMessage | null>;
  /** An item left the queue for good without being sent from it: deleted, cleared, or taken in
   *  by the running turn. What it holds can be let go (its thumbnails). */
  release?: (item: QueuedMessage<P>) => void;
}) {
  const releaseRef = useRef(release);
  useEffect(() => {
    releaseRef.current = release;
  });
  const [queues, setQueuesState] = useState<QueueMap<P>>({});
  const queuesRef = useRef<QueueMap<P>>({});
  const [delivering, setDelivering] = useState<Record<string, QueuedMessage<P>[]>>({});
  const deliveringRef = useRef<Record<string, QueuedMessage<P>[]>>({});
  const prepared = useRef(new Map<string, InboxMessage | null>());
  const arrive = useRef<Listeners>(new Map());
  const hurry = useRef<Listeners>(new Map());
  const [tick, setTick] = useState(0);
  const dispatching = useRef(new Set<string>());
  const sendRef = useRef(send);
  const abortRef = useRef(abort);
  const prepareRef = useRef(prepare);
  const busyIdsRef = useRef(busyIds);
  useEffect(() => {
    sendRef.current = send;
    abortRef.current = abort;
    prepareRef.current = prepare;
    busyIdsRef.current = busyIds;
  });

  const mutate = useCallback((fn: (m: QueueMap<P>) => QueueMap<P>) => {
    const next = fn(queuesRef.current);
    if (next === queuesRef.current) return;
    queuesRef.current = next;
    setQueuesState(next);
  }, []);

  const setDeliveringFor = useCallback((chatId: string, fn: (items: QueuedMessage<P>[]) => QueuedMessage<P>[]) => {
    const prev = deliveringRef.current[chatId] ?? [];
    const items = fn(prev);
    if (items === prev) return;
    const next = { ...deliveringRef.current };
    if (items.length) next[chatId] = items;
    else delete next[chatId];
    deliveringRef.current = next;
    setDelivering(next);
  }, []);

  const track = useCallback((chatId: string, item: QueuedMessage<P>) => {
    prepared.current.delete(item.id);
    void prepareRef.current(item)
      .catch(() => null)
      .then((msg) => {
        prepared.current.set(item.id, msg);
        notify(arrive.current, chatId);
      });
  }, []);

  useEffect(() => {
    for (const { chatId, item: next } of readyToSend(queues, (id) => busyIds.has(id) || dispatching.current.has(id))) {
      dispatching.current.add(chatId);
      void Promise.resolve()
        .then(() => {
          mutate((m) => removeItem(m, chatId, next.id));
          prepared.current.delete(next.id);
          return sendRef.current(next, chatId);
        })
        .catch(() => undefined)
        .finally(() => {
          dispatching.current.delete(chatId);
          setTick((n) => n + 1);
        });
    }
  }, [busyIds, queues, tick, mutate]);

  const inboxFor = useCallback(
    (chatId: string): TurnInbox => ({
      take: () => {
        const q = queuesRef.current[chatId];
        if (!q || q.paused) return [];
        const taken: QueuedMessage<P>[] = [];
        const out: InboxMessage[] = [];
        for (const item of q.items) {
          const msg = prepared.current.get(item.id);
          if (!msg) break;
          taken.push(item);
          out.push(msg);
        }
        if (!taken.length) return [];
        const ids = new Set(taken.map((i) => i.id));
        mutate((m) => {
          let n = m;
          for (const id of ids) n = removeItem(n, chatId, id);
          return n;
        });
        for (const id of ids) prepared.current.delete(id);
        setDeliveringFor(chatId, (items) => [...items, ...taken]);
        return out;
      },
      consumed: (items) => {
        const ids = new Set(items.map((i) => i.id));
        for (const item of deliveringRef.current[chatId] ?? []) if (ids.has(item.id)) releaseRef.current?.(item);
        setDeliveringFor(chatId, (list) => list.filter((i) => !ids.has(i.id)));
      },
      onArrive: (fn) => listen(arrive.current, chatId, fn),
      onHurry: (fn) => listen(hurry.current, chatId, fn),
    }),
    [mutate, setDeliveringFor],
  );

  const drainDelivering = useCallback(
    (chatId: string): QueuedMessage<P>[] => {
      const items = deliveringRef.current[chatId] ?? [];
      if (items.length) setDeliveringFor(chatId, () => []);
      return items;
    },
    [setDeliveringFor],
  );

  const enqueueMessage = useCallback(
    (payload: P, displayText?: string) => {
      if (!activeId) return;
      const item = { id: newId(), payload, displayText };
      mutate((m) => setPaused(enqueue(m, activeId, item), activeId, false));
      track(activeId, item);
    },
    [activeId, mutate, track],
  );

  const steer = useCallback(
    (payload: P, displayText?: string) => {
      if (!activeId) return;
      const item = { id: newId(), payload, displayText };
      mutate((m) => prioritize(m, activeId, item));
      if (busyIdsRef.current.has(activeId)) abortRef.current(activeId);
    },
    [activeId, mutate],
  );

  const sendNow = useCallback(
    (id: string) => {
      if (!activeId) return;
      const chatId = activeId;
      const inFlight = (deliveringRef.current[chatId] ?? []).some((i) => i.id === id);
      const busy = busyIdsRef.current.has(chatId);
      if (busy && hurry.current.has(chatId)) {
        if (!inFlight) {
          mutate((m) => setPaused(promote(m, chatId, id), chatId, false));
          notify(arrive.current, chatId);
        }
        notify(hurry.current, chatId);
        return;
      }
      if (inFlight) return;
      mutate((m) => promote(m, chatId, id));
      if (busy) abortRef.current(chatId);
    },
    [activeId, mutate],
  );

  const remove = useCallback(
    (id: string) => {
      if (!activeId) return;
      const item = queuesRef.current[activeId]?.items.find((i) => i.id === id);
      if (item) releaseRef.current?.(item);
      mutate((m) => removeItem(m, activeId, id));
      prepared.current.delete(id);
    },
    [activeId, mutate],
  );

  const edit = useCallback(
    (id: string, message: string) => {
      if (!activeId) return;
      mutate((m) => editItem(m, activeId, id, message));
      const item = queuesRef.current[activeId]?.items.find((i) => i.id === id);
      if (item) track(activeId, item);
    },
    [activeId, mutate, track],
  );

  const pause = useCallback(
    (chatId: string | null) => {
      if (chatId) mutate((m) => setPaused(m, chatId, true));
    },
    [mutate],
  );

  const resume = useCallback(() => {
    if (activeId) mutate((m) => setPaused(m, activeId, false));
  }, [activeId, mutate]);

  const clear = useCallback(() => {
    if (!activeId) return;
    for (const item of queuesRef.current[activeId]?.items ?? []) releaseRef.current?.(item);
    mutate((m) => clearQueue(m, activeId));
  }, [activeId, mutate]);

  const current = activeId ? queues[activeId] : undefined;
  const inFlight = useMemo(() => (activeId ? delivering[activeId] ?? [] : []), [activeId, delivering]);
  /** Messages wait in this chat's queue (any chat, not only the open one). */
  const hasQueued = useCallback((chatId: string) => (queuesRef.current[chatId]?.items.length ?? 0) > 0, []);

  return {
    items: current?.items ?? [],
    hasQueued,
    delivering: inFlight,
    paused: current?.paused ?? false,
    enqueue: enqueueMessage,
    steer,
    sendNow,
    remove,
    edit,
    pause,
    resume,
    clear,
    inboxFor,
    drainDelivering,
  };
}
