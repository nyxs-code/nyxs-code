/** How long text and reasoning deltas are gathered before they reach the chat, so a fast
 *  stream re-renders the message a dozen times a second instead of once per token. */
const MIN_FLUSH_MS = 80;
/** The same for a chat nobody is looking at: each update re-renders the whole app, and several
 *  sessions streaming at once in the background made the visible animations stutter. */
const HIDDEN_FLUSH_MS = 500;

export interface StreamBufferSink {
  /** Text to append to the reply. */
  content: (delta: string) => void;
  /** Reasoning to append, by block id, with when each block started and last grew. */
  reasoning: (deltas: Record<string, string>, times: Record<string, { start: number; end: number }>) => void;
}

/** The chats on screen; `null` until the app says, which counts every chat as shown. */
let shownChats: ReadonlySet<string> | null = null;

/** Tells the buffers which chats are on screen, so the others update less often. */
export function setShownChats(ids: Iterable<string> | null): void {
  shownChats = ids ? new Set(ids) : null;
}

const isShown = (chatId: string | undefined) => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return !chatId || !shownChats || shownChats.has(chatId);
};

/** Every buffer's next delivery, run by one shared timer: buffers due at the same moment are
 *  delivered in the same task, so React renders their chats' updates once, not once each. */
const due = new Map<() => void, { at: number; now: () => number }>();
let timer: ReturnType<typeof setTimeout> | null = null;

function arm() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  let wait = Infinity;
  for (const { at, now } of due.values()) wait = Math.min(wait, at - now());
  if (wait !== Infinity) timer = setTimeout(tick, Math.max(0, wait));
}

function tick() {
  timer = null;
  for (const [deliver, { at, now }] of [...due]) {
    if (now() < at) continue;
    due.delete(deliver);
    deliver();
  }
  arm();
}

/** Gathers a reply's streamed text and reasoning and hands them over in batches. `flush()`
 *  delivers what is waiting right away (call it before anything that reads the message). */
export function createStreamBuffer(sink: StreamBufferSink, now: () => number = Date.now, chatId?: string) {
  let pendingContent = "";
  let pendingReasoning: Record<string, string> = {};
  const reasoningTimes: Record<string, { start: number; end: number }> = {};
  let lastFlushAt = 0;

  const deliver = () => {
    lastFlushAt = now();
    if (pendingContent) {
      const delta = pendingContent;
      pendingContent = "";
      sink.content(delta);
    }
    if (Object.keys(pendingReasoning).length) {
      const deltas = pendingReasoning;
      pendingReasoning = {};
      sink.reasoning(deltas, { ...reasoningTimes });
    }
  };
  const schedule = () => {
    if (due.has(deliver)) return;
    const t = now();
    const interval = isShown(chatId) ? MIN_FLUSH_MS : HIDDEN_FLUSH_MS;
    let at = t + Math.max(0, interval - (t - lastFlushAt));
    // On a shared grid, so streams running side by side land on the same tick. The first delta
    // after a pause isn't held back.
    if (at > t) at = Math.ceil(at / MIN_FLUSH_MS) * MIN_FLUSH_MS;
    due.set(deliver, { at, now });
    arm();
  };

  return {
    content(delta: string) {
      pendingContent += delta;
      schedule();
    },
    reasoning(id: string, delta: string) {
      const at = now();
      reasoningTimes[id] = { start: reasoningTimes[id]?.start ?? at, end: at };
      pendingReasoning[id] = (pendingReasoning[id] ?? "") + delta;
      schedule();
    },
    flush() {
      if (due.delete(deliver)) arm();
      deliver();
    },
  };
}
