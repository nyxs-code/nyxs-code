import { createWorkflowStore, type WorkflowStore } from "./orchestratorStore";

const stores = new Map<string, WorkflowStore>();

/** The Workflow and sub-agent view of one chat, so two chats' agents don't mix nor clear each
 *  other's. Without a chat (headless runs), a store of its own. */
export function getWorkflowStore(chatId = ""): WorkflowStore {
  let store = stores.get(chatId);
  if (!store) stores.set(chatId, (store = createWorkflowStore()));
  return store;
}

/** Clears a chat's view for a new run, unless some of its agents still run: the new ones join
 *  them then. */
export function resetWorkflow(chatId = ""): void {
  const store = stores.get(chatId);
  if (store && store.getSnapshot().running === 0) store.reset();
}
