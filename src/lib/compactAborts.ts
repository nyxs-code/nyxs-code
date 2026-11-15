/** A running `/compact`: its signal, and `release` once it is over. */
export interface CompactRun {
  signal: AbortSignal;
  release: () => void;
}

/** The controllers of the `/compact` runs, per chat. `/compact` runs outside a turn, so the
 *  turn's controller can't stop it; stopping the chat (Esc, the stop button) aborts this one. */
export function createCompactAborts() {
  const controllers = new Map<string, AbortController>();
  return {
    start(chatId: string): CompactRun {
      controllers.get(chatId)?.abort();
      const controller = new AbortController();
      controllers.set(chatId, controller);
      return {
        signal: controller.signal,
        // A newer run of the same chat keeps its own controller.
        release: () => {
          if (controllers.get(chatId) === controller) controllers.delete(chatId);
        },
      };
    },
    /** Aborts the chat's `/compact`, if one is running. */
    abort(chatId: string): boolean {
      const controller = controllers.get(chatId);
      if (!controller) return false;
      controllers.delete(chatId);
      controller.abort();
      return true;
    },
  };
}
