export interface QueuedMessage<P extends { message: string }> {
  id: string;
  payload: P;
  displayText?: string;
}

export interface ChatQueue<P extends { message: string }> {
  items: QueuedMessage<P>[];
  paused: boolean;
}

export type QueueMap<P extends { message: string }> = Record<string, ChatQueue<P>>;

function withQueue<P extends { message: string }>(
  map: QueueMap<P>,
  chatId: string,
  update: (q: ChatQueue<P>) => ChatQueue<P>,
): QueueMap<P> {
  const prev = map[chatId] ?? { items: [], paused: false };
  const next = update(prev);
  if (next === prev) return map;
  const out = { ...map };
  if (!next.items.length && !next.paused) delete out[chatId];
  else out[chatId] = next;
  return out;
}

export function enqueue<P extends { message: string }>(
  map: QueueMap<P>,
  chatId: string,
  item: QueuedMessage<P>,
): QueueMap<P> {
  return withQueue(map, chatId, (q) => ({ ...q, items: [...q.items, item] }));
}

export function prioritize<P extends { message: string }>(
  map: QueueMap<P>,
  chatId: string,
  item: QueuedMessage<P>,
): QueueMap<P> {
  return withQueue(map, chatId, (q) => ({ paused: false, items: [item, ...q.items.filter((i) => i.id !== item.id)] }));
}

export function promote<P extends { message: string }>(map: QueueMap<P>, chatId: string, id: string): QueueMap<P> {
  const item = map[chatId]?.items.find((i) => i.id === id);
  return item ? prioritize(map, chatId, item) : map;
}

export function removeItem<P extends { message: string }>(map: QueueMap<P>, chatId: string, id: string): QueueMap<P> {
  return withQueue(map, chatId, (q) => {
    const items = q.items.filter((i) => i.id !== id);
    if (items.length === q.items.length) return q;
    return { paused: items.length ? q.paused : false, items };
  });
}

export function editItem<P extends { message: string }>(
  map: QueueMap<P>,
  chatId: string,
  id: string,
  message: string,
): QueueMap<P> {
  return withQueue(map, chatId, (q) => {
    if (!q.items.some((i) => i.id === id)) return q;
    return {
      ...q,
      items: q.items.map((i) => (i.id === id ? { ...i, displayText: undefined, payload: { ...i.payload, message } } : i)),
    };
  });
}

/** Moves a queued message to `toIndex` in its chat's queue (the user dragged it there). */
export function moveItem<P extends { message: string }>(map: QueueMap<P>, chatId: string, id: string, toIndex: number): QueueMap<P> {
  return withQueue(map, chatId, (q) => {
    const from = q.items.findIndex((i) => i.id === id);
    const to = Math.max(0, Math.min(q.items.length - 1, toIndex));
    if (from < 0 || from === to) return q;
    const items = [...q.items];
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    return { ...q, items };
  });
}

export function setPaused<P extends { message: string }>(map: QueueMap<P>, chatId: string, paused: boolean): QueueMap<P> {
  return withQueue(map, chatId, (q) => (q.paused === paused || (paused && !q.items.length) ? q : { ...q, paused }));
}

export function clearQueue<P extends { message: string }>(map: QueueMap<P>, chatId: string): QueueMap<P> {
  return withQueue(map, chatId, (q) => (q.items.length || q.paused ? { items: [], paused: false } : q));
}

export function nextToSend<P extends { message: string }>(
  map: QueueMap<P>,
  chatId: string | null,
  busy: boolean,
): QueuedMessage<P> | null {
  if (!chatId || busy) return null;
  const q = map[chatId];
  if (!q || q.paused) return null;
  return q.items[0] ?? null;
}

/** The next message of every chat that can take one now: a queue is sent when its own chat's
 *  turn ends, whichever chat is open. */
export function readyToSend<P extends { message: string }>(
  map: QueueMap<P>,
  isBusy: (chatId: string) => boolean,
): Array<{ chatId: string; item: QueuedMessage<P> }> {
  return Object.keys(map).flatMap((chatId) => {
    const item = nextToSend(map, chatId, isBusy(chatId));
    return item ? [{ chatId, item }] : [];
  });
}
