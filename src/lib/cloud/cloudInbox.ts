import { getCurrentUserId } from "@/lib/auth";
import { notifyQuestion, notifyTurnDone, notifyTurnError } from "@/lib/notify";
import { listCloudThreads, type CloudThread, type CloudThreadStatus } from "./cloudApi";

// What changed in the user's cloud threads since the app last looked: a thread that finished,
// failed or started waiting for the user while the app was closed sends one notification each
// (spec, Phase 3). The statuses last seen are kept per account in localStorage.

const STORE = "nyxs.cloud.lastSeen.v1";
const storeKey = () => `${STORE}::${getCurrentUserId() ?? "anon"}`;

export type CloudChange = { thread: CloudThread; kind: "review" | "needs_input" | "failed" };

const ATTENTION: Partial<Record<CloudThreadStatus, CloudChange["kind"]>> = {
  review: "review",
  needs_input: "needs_input",
  failed: "failed",
};

/** The threads whose status now asks for the user and wasn't that status last time. A thread
 *  never seen before counts only if it was created after the last check (`since`), so the very
 *  first check after installing doesn't notify for old threads. */
export function cloudChanges(lastSeen: Record<string, string>, threads: CloudThread[], since: string | null): CloudChange[] {
  const out: CloudChange[] = [];
  for (const thread of threads) {
    const kind = ATTENTION[thread.status];
    if (!kind) continue;
    const before = lastSeen[thread.id];
    if (before === thread.status) continue;
    if (before === undefined && (!since || thread.updatedAt <= since)) continue;
    out.push({ thread, kind });
  }
  return out;
}

function readLastSeen(): { at: string | null; statuses: Record<string, string> } {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) ?? "null") as { at?: string; statuses?: Record<string, string> } | null;
    return { at: raw?.at ?? null, statuses: raw?.statuses ?? {} };
  } catch {
    return { at: null, statuses: {} };
  }
}

/** Records the statuses on screen now, so they don't notify again. */
export function rememberCloudStatuses(threads: CloudThread[]): void {
  const statuses = Object.fromEntries(threads.map((t) => [t.id, t.status]));
  localStorage.setItem(storeKey(), JSON.stringify({ at: new Date().toISOString(), statuses }));
}

/**
 * Lists the cloud threads, notifies for each change that asks for the user, and remembers what it
 * saw. `chatIdOf` gives the Nyxs session a cloud thread is shown in, so the notification opens it.
 * Returns the threads (to update the sessions) or null when the cloud can't be reached.
 */
export async function checkCloudInbox(chatIdOf: (cloudThreadId: string) => string | undefined): Promise<CloudThread[] | null> {
  let threads: CloudThread[];
  try {
    threads = await listCloudThreads();
  } catch {
    return null;
  }
  const { at, statuses } = readLastSeen();
  for (const { thread, kind } of cloudChanges(statuses, threads, at)) {
    const chatId = chatIdOf(thread.id);
    if (kind === "needs_input") await notifyQuestion(thread.preview ?? thread.title, chatId);
    else if (kind === "failed") await notifyTurnError(thread.preview ?? thread.title, chatId);
    else await notifyTurnDone(chatId);
  }
  rememberCloudStatuses(threads);
  return threads;
}
