/** How to stop each chat's running reply, for code that only knows the chat: a CLI's sub-agent
 *  the CLI can't stop alone stops the whole reply, as Esc would. Filled by `runAssistantTurn`. */
const aborts = new Map<string, AbortController>();

export function setTurnAbort(chatId: string, controller: AbortController | null): void {
  if (controller) aborts.set(chatId, controller);
  else aborts.delete(chatId);
}

/** Stops the chat's running reply. False when none is running. */
export function abortChatTurn(chatId: string | undefined): boolean {
  const controller = chatId ? aborts.get(chatId) : undefined;
  if (!controller) return false;
  controller.abort();
  return true;
}
