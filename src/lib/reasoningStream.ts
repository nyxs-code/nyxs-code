// MiniMax's M3 models served by others (NVIDIA, OpenRouter...) write their reasoning in the
// answer inside <mm:think>, not <think>.
const OPEN_TAGS = ["<think>", "<mm:think>"];
const CLOSE_TAGS = ["</think>", "</mm:think>"];
const ALL_TAGS = [...OPEN_TAGS, ...CLOSE_TAGS];
export const ANSWER_HOLD_CAP = 240;
export const ANSWER_HOLD_MS = 300;

export interface ReasoningRouterOptions {
  passthrough: boolean;
  emit: (text: string) => void;
  emitReasoning: (text: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ReasoningRouter {
  push: (chunk: string) => void;
  flush: () => void;
  markReasoningSeen: () => void;
  /** A new model step starts: it may open with its own reasoning again. */
  newStep: () => void;
}

export function partialTagLen(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/** The longest tail of `s` that could still grow into one of `tags`. */
function partialAnyLen(s: string, tags: string[]): number {
  return Math.max(...tags.map((t) => partialTagLen(s, t)));
}

/** The earliest opening or closing reasoning tag in `s`, with its length. */
export function firstTag(s: string): { kind: "open" | "close"; i: number; len: number } | null {
  let best: { kind: "open" | "close"; i: number; len: number } | null = null;
  for (const [kind, tags] of [["open", OPEN_TAGS], ["close", CLOSE_TAGS]] as const) {
    for (const tag of tags) {
      const i = s.indexOf(tag);
      if (i !== -1 && (!best || i < best.i)) best = { kind, i, len: tag.length };
    }
  }
  return best;
}

function firstClose(s: string): { i: number; len: number } | null {
  let best: { i: number; len: number } | null = null;
  for (const tag of CLOSE_TAGS) {
    const i = s.indexOf(tag);
    if (i !== -1 && (!best || i < best.i)) best = { i, len: tag.length };
  }
  return best;
}

export function createReasoningRouter(opts: ReasoningRouterOptions): ReasoningRouter {
  const { passthrough, emitReasoning } = opts;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let mode: "answer" | "think" = "answer";
  let hold = "";
  let reasoningSeen = false;
  let holdTimer: unknown = null;
  // Reasoning tags only open a step: once the step's answer has begun, a tag is the answer's own
  // text (code or docs about <think>), not the model starting to think again.
  let answered = false;
  const emit = (text: string) => {
    if (text.trim()) answered = true;
    opts.emit(text);
  };

  const clearHoldTimer = () => {
    if (holdTimer !== null) {
      clearTimer(holdTimer);
      holdTimer = null;
    }
  };

  const flushAnswerHold = () => {
    holdTimer = null;
    if (mode !== "answer" || !hold) return;
    const partial = partialAnyLen(hold, ALL_TAGS);
    const flushable = hold.length - partial;
    if (flushable > 0) {
      emit(hold.slice(0, flushable));
      hold = hold.slice(flushable);
    }
  };

  const push = (chunk: string) => {
    if (passthrough) {
      emit(chunk);
      return;
    }
    clearHoldTimer();
    hold += chunk;
    for (;;) {
      if (mode === "answer") {
        if (answered) {
          emit(hold);
          hold = "";
          return;
        }
        const t = firstTag(hold);
        if (t?.kind === "open" && hold.slice(0, t.i).trim()) {
          emit(hold);
          hold = "";
          return;
        }
        if (t?.kind === "open") {
          if (t.i > 0) emit(hold.slice(0, t.i));
          hold = hold.slice(t.i + t.len);
          mode = "think";
          continue;
        }
        if (t?.kind === "close") {
          if (t.i > 0) emitReasoning(hold.slice(0, t.i));
          hold = hold.slice(t.i + t.len);
          reasoningSeen = true;
          continue;
        }
        const partial = partialAnyLen(hold, ALL_TAGS);
        const flushable = hold.length - partial;
        if (flushable > 0 && (reasoningSeen || flushable >= ANSWER_HOLD_CAP)) {
          emit(hold.slice(0, flushable));
          hold = hold.slice(flushable);
        } else if (flushable > 0) {
          holdTimer = setTimer(flushAnswerHold, ANSWER_HOLD_MS);
        }
        return;
      }
      const c = firstClose(hold);
      if (c) {
        if (c.i > 0) emitReasoning(hold.slice(0, c.i));
        hold = hold.slice(c.i + c.len);
        mode = "answer";
        reasoningSeen = true;
        continue;
      }
      const partial = partialAnyLen(hold, CLOSE_TAGS);
      if (hold.length - partial > 0) {
        emitReasoning(hold.slice(0, hold.length - partial));
        hold = hold.slice(hold.length - partial);
      }
      return;
    }
  };

  const flush = () => {
    clearHoldTimer();
    if (!hold) return;
    if (mode === "think") emitReasoning(hold);
    else emit(hold);
    hold = "";
  };

  return {
    push,
    flush,
    markReasoningSeen: () => {
      reasoningSeen = true;
    },
    newStep: () => {
      flush();
      mode = "answer";
      answered = false;
    },
  };
}
